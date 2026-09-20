'use strict';

const zlib = require('node:zlib');
const { invariant } = require('../domain/contracts');

// The Companion deliberately rejects animation and unusually large inputs instead
// of letting a decompressor allocate unbounded memory for an untrusted header.
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_DIMENSION = 32768;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function dimensions(width, height) {
  invariant(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0, 'INVALID_IMAGE', 'Image dimensions must be positive integers');
  invariant(width <= MAX_DIMENSION && height <= MAX_DIMENSION && width * height <= MAX_PIXELS, 'IMAGE_TOO_LARGE', 'Image dimensions exceed the production input limit');
  return { width, height };
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function png(data) {
  let offset = 8, header, ended = false, sawData = false, dataEnded = false, palette = false;
  const compressed = [];
  while (offset < data.length) {
    invariant(offset + 12 <= data.length, 'INVALID_IMAGE', 'PNG chunk is truncated');
    const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8);
    invariant(length <= MAX_BYTES && offset + length + 12 <= data.length, 'INVALID_IMAGE', 'PNG chunk length is invalid');
    invariant(/^[A-Za-z]{4}$/.test(type) && (data[offset + 6] & 32) === 0, 'INVALID_IMAGE', 'PNG chunk type is invalid');
    invariant(crc32(data.subarray(offset + 4, offset + 8 + length)) === data.readUInt32BE(offset + 8 + length), 'INVALID_IMAGE', 'PNG checksum is invalid');
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    invariant(header || type === 'IHDR', 'INVALID_IMAGE', 'PNG is missing its first header');
    if (type === 'IHDR') {
      invariant(!header && length === 13, 'INVALID_IMAGE', 'PNG header is invalid');
      const width = chunk.readUInt32BE(0), height = chunk.readUInt32BE(4), bitDepth = chunk[8], colorType = chunk[9];
      dimensions(width, height);
      const allowed = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      invariant(allowed[colorType] && allowed[colorType].includes(bitDepth) && chunk[10] === 0 && chunk[11] === 0 && chunk[12] <= 1, 'INVALID_IMAGE', 'PNG pixel format is invalid');
      header = { width, height, bitDepth, colorType, interlace: chunk[12] };
    } else if (type === 'PLTE') {
      invariant(!palette && !sawData && length > 0 && length <= 768 && length % 3 === 0 && ![0, 4].includes(header.colorType), 'INVALID_IMAGE', 'PNG palette is invalid');
      invariant(header.colorType !== 3 || length / 3 <= 2 ** header.bitDepth, 'INVALID_IMAGE', 'PNG palette exceeds its pixel depth');
      palette = true;
    } else if (type === 'IDAT') {
      invariant(!dataEnded && (header.colorType !== 3 || palette), 'INVALID_IMAGE', 'PNG image chunks are invalid');
      sawData = true; compressed.push(chunk);
    } else if (type === 'IEND') {
      invariant(length === 0 && sawData && offset + 12 === data.length, 'INVALID_IMAGE', 'PNG end marker is invalid');
      ended = true;
    } else {
      invariant(!['acTL', 'fcTL', 'fdAT'].includes(type), 'UNSUPPORTED_IMAGE', 'Animated PNG inputs are not supported');
      invariant((data[offset + 4] & 32) !== 0, 'UNSUPPORTED_IMAGE', 'PNG contains an unsupported critical chunk');
      if (sawData) dataEnded = true;
    }
    offset += length + 12;
  }
  invariant(ended, 'INVALID_IMAGE', 'PNG is missing its end marker');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  const passes = header.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((header.width - x) / dx)), height = Math.max(0, Math.ceil((header.height - y) / dy));
    return { height: width ? height : 0, rowBytes: Math.ceil(width * channels * header.bitDepth / 8) + 1 };
  });
  const expected = rows.reduce((sum, pass) => sum + pass.height * pass.rowBytes, 0);
  invariant(expected <= MAX_DECODED_BYTES, 'IMAGE_TOO_LARGE', 'Decoded PNG exceeds the production input limit');
  let decoded;
  try {
    const result = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: expected, info: true });
    invariant(result.engine.bytesWritten === compressed.reduce((sum, part) => sum + part.length, 0), 'INVALID_IMAGE', 'PNG has trailing compressed data');
    decoded = result.buffer;
  } catch (error) {
    invariant(false, 'INVALID_IMAGE', 'PNG pixel data is invalid or truncated');
  }
  invariant(decoded.length === expected, 'INVALID_IMAGE', 'PNG pixel data does not match its dimensions');
  let cursor = 0;
  for (const pass of rows) for (let y = 0; y < pass.height; y++, cursor += pass.rowBytes) invariant(decoded[cursor] <= 4, 'INVALID_IMAGE', 'PNG row filter is invalid');
  return { width: header.width, height: header.height, bitDepth: header.bitDepth, mimeType: 'image/png' };
}
function jpeg(data) {
  let offset = 2, header, scans = 0, ended = false;
  while (offset < data.length) {
    invariant(data[offset++] === 0xff, 'INVALID_IMAGE', 'JPEG marker is invalid');
    while (offset < data.length && data[offset] === 0xff) offset++;
    invariant(offset < data.length, 'INVALID_IMAGE', 'JPEG marker is truncated');
    const marker = data[offset++];
    if (marker === 0xd9) { ended = true; break; }
    invariant(marker !== 0x00 && marker !== 0xd8 && !(marker >= 0xd0 && marker <= 0xd7), 'INVALID_IMAGE', 'JPEG marker order is invalid');
    if (marker === 0x01) continue;
    invariant(offset + 2 <= data.length, 'INVALID_IMAGE', 'JPEG segment is truncated');
    const length = data.readUInt16BE(offset);
    invariant(length >= 2 && offset + length <= data.length, 'INVALID_IMAGE', 'JPEG segment length is invalid');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      invariant(!header && length >= 8, 'INVALID_IMAGE', 'JPEG frame header is invalid');
      const bitDepth = data[offset + 2], height = data.readUInt16BE(offset + 3), width = data.readUInt16BE(offset + 5), components = data[offset + 7];
      invariant(bitDepth === 8 && [1, 3, 4].includes(components) && length === 8 + 3 * components, 'UNSUPPORTED_IMAGE', 'JPEG pixel format is not supported');
      dimensions(width, height); header = { width, height, bitDepth, mimeType: 'image/jpeg' };
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      invariant(false, 'UNSUPPORTED_IMAGE', 'JPEG coding format is not supported');
    }
    if (marker === 0xda) {
      invariant(header && length >= 6 && data[offset + 2] > 0 && length === 6 + 2 * data[offset + 2], 'INVALID_IMAGE', 'JPEG scan header is invalid');
      scans++; offset += length;
      const start = offset;
      while (offset < data.length) {
        if (data[offset] !== 0xff) { offset++; continue; }
        if (offset + 1 < data.length && (data[offset + 1] === 0x00 || (data[offset + 1] >= 0xd0 && data[offset + 1] <= 0xd7))) { offset += 2; continue; }
        break;
      }
      invariant(offset > start, 'INVALID_IMAGE', 'JPEG scan is empty');
    } else offset += length;
  }
  invariant(header && scans > 0 && ended && offset === data.length, 'INVALID_IMAGE', 'JPEG image is incomplete or has trailing data');
  return header;
}
function webp(data) {
  invariant(data.length >= 20 && data.readUInt32LE(4) + 8 === data.length, 'INVALID_IMAGE', 'WebP container length is invalid');
  let offset = 12, header, canvas, chunks = 0;
  while (offset < data.length) {
    invariant(offset + 8 <= data.length, 'INVALID_IMAGE', 'WebP chunk is truncated');
    const type = data.toString('ascii', offset, offset + 4), length = data.readUInt32LE(offset + 4), start = offset + 8;
    invariant(length <= MAX_BYTES && start + length + (length & 1) <= data.length, 'INVALID_IMAGE', 'WebP chunk length is invalid');
    if (type === 'VP8X') {
      invariant(chunks === 0 && length === 10 && (data[start] & 0xc1) === 0 && data.readUIntLE(start + 1, 3) === 0, 'INVALID_IMAGE', 'WebP extended header is invalid');
      invariant((data[start] & 2) === 0, 'UNSUPPORTED_IMAGE', 'Animated WebP inputs are not supported');
      canvas = dimensions(data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1);
    } else if (type === 'ANIM' || type === 'ANMF') {
      invariant(false, 'UNSUPPORTED_IMAGE', 'Animated WebP inputs are not supported');
    } else if (type === 'VP8 ') {
      invariant(!header && length > 10 && (data[start] & 1) === 0 && data.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a])), 'INVALID_IMAGE', 'WebP lossy image header is invalid');
      invariant((data.readUIntLE(start, 3) >>> 5) <= length - 10, 'INVALID_IMAGE', 'WebP lossy partition is truncated');
      header = dimensions(data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff);
    } else if (type === 'VP8L') {
      invariant(!header && length > 5 && data[start] === 0x2f, 'INVALID_IMAGE', 'WebP lossless image header is invalid');
      const bits = data.readUInt32LE(start + 1);
      invariant((bits >>> 29) === 0, 'UNSUPPORTED_IMAGE', 'WebP lossless version is not supported');
      header = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (length & 1) invariant(data[start + length] === 0, 'INVALID_IMAGE', 'WebP padding is invalid');
    offset = start + length + (length & 1); chunks++;
  }
  invariant(header && (!canvas || (canvas.width === header.width && canvas.height === header.height)), 'INVALID_IMAGE', 'WebP canvas does not match its image');
  return { ...header, bitDepth: 8, mimeType: 'image/webp' };
}
function inspectImage(data) {
  invariant(Buffer.isBuffer(data) && data.length > 0, 'INVALID_IMAGE', 'Image data must be a nonempty Buffer');
  invariant(data.length <= MAX_BYTES, 'IMAGE_TOO_LARGE', 'Image bytes exceed the production input limit');
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) return png(data);
  if (data[0] === 0xff && data[1] === 0xd8) return jpeg(data);
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return webp(data);
  invariant(false, 'UNSUPPORTED_IMAGE', 'Only PNG, JPEG and static WebP images are supported');
}
module.exports = { inspectImage, MAX_BYTES, MAX_PIXELS, MAX_DIMENSION };
