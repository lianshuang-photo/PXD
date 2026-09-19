/* Small, dependency-free production pixel helpers. No browser canvas or Node APIs. */
(function () {
  "use strict";
  var MAX_PIXELS = 8000000, MAX_BYTES = 32 * 1024 * 1024;
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  function dimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) fail("INVALID_INPUT", "图像尺寸无效");
    if (width * height > MAX_PIXELS) fail("IMAGE_TOO_LARGE", "当前生产路径最多支持 8,000,000 像素；请明确缩小处理选区，不会自动缩小原图");
  }
  function u32(bytes, offset) { return (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0; }
  function write32(bytes, offset, value) { bytes[offset] = value >>> 24; bytes[offset + 1] = value >>> 16; bytes[offset + 2] = value >>> 8; bytes[offset + 3] = value; }
  var crcTable;
  function crc32(bytes) {
    if (!crcTable) { crcTable = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; crcTable[n] = c; } }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(name, data) {
    var result = new Uint8Array(data.length + 12); write32(result, 0, data.length);
    for (var i = 0; i < 4; i++) result[i + 4] = name.charCodeAt(i);
    result.set(data, 8); write32(result, data.length + 8, crc32(result.subarray(4, data.length + 8))); return result;
  }
  function encodePNG(width, height, pixels, components) {
    dimensions(width, height);
    if ([1, 3, 4].indexOf(components) < 0 || !(pixels instanceof Uint8Array) || pixels.length !== width * height * components) fail("HOST_PIXEL_FORMAT", "生产像素格式不匹配");
    var stride = width * components + 1, raw = new Uint8Array(stride * height);
    for (var y = 0; y < height; y++) raw.set(pixels.subarray(y * width * components, (y + 1) * width * components), y * stride + 1);
    var blocks = Math.ceil(raw.length / 65535), compressed = new Uint8Array(2 + blocks * 5 + raw.length + 4), p = 2;
    compressed[0] = 120; compressed[1] = 1;
    for (var block = 0; block < blocks; block++) {
      var start = block * 65535, len = Math.min(65535, raw.length - start);
      compressed[p++] = block === blocks - 1 ? 1 : 0;
      compressed[p++] = len & 255; compressed[p++] = len >>> 8; compressed[p++] = ~len & 255; compressed[p++] = ~len >>> 8 & 255;
      compressed.set(raw.subarray(start, start + len), p); p += len;
    }
    var a = 1, b = 0;
    for (var j = 0; j < raw.length; j++) { a = (a + raw[j]) % 65521; b = (b + a) % 65521; }
    write32(compressed, p, (b << 16 | a) >>> 0);
    var header = new Uint8Array(13); write32(header, 0, width); write32(header, 4, height); header[8] = 8; header[9] = components === 1 ? 0 : components === 3 ? 2 : 6;
    var parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
    // RGB/RGBA capture is explicitly converted by Photoshop to this profile.
    if (components !== 1) parts.push(chunk("sRGB", new Uint8Array([0])));
    parts.push(chunk("IDAT", compressed), chunk("IEND", new Uint8Array(0)));
    var total = parts.reduce(function (n, v) { return n + v.length; }, 0);
    if (total > MAX_BYTES) fail("IMAGE_TOO_LARGE", "生产图像编码超过 32 MiB，未进行隐式压缩或缩放");
    var png = new Uint8Array(total), offset = 0; parts.forEach(function (v) { png.set(v, offset); offset += v.length; }); return png;
  }
  function inspectImage(bytes, mimeType) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES) fail("IMAGE_TOO_LARGE", "图像必须是有效且不超过 32 MiB 的 PNG/JPEG");
    var width, height;
    if (mimeType === "image/png") {
      if (bytes.length < 45 || [137, 80, 78, 71, 13, 10, 26, 10].some(function (v, i) { return bytes[i] !== v; }) || u32(bytes, 8) !== 13 || String.fromCharCode.apply(null, bytes.subarray(12, 16)) !== "IHDR") fail("INVALID_IMAGE", "PNG 文件头无效");
      width = u32(bytes, 16); height = u32(bytes, 20);
      for (var pos = 8, ended = false, hasData = false; pos + 12 <= bytes.length;) {
        var len = u32(bytes, pos), name = String.fromCharCode.apply(null, bytes.subarray(pos + 4, pos + 8));
        if (pos + len + 12 > bytes.length) fail("INVALID_IMAGE", "PNG 数据不完整");
        if (name === "acTL") fail("UNSUPPORTED_FORMAT", "生产回写暂不接受动画 PNG");
        if (name === "IDAT") hasData = true;
        if (name === "IEND") { ended = len === 0 && pos + 12 === bytes.length; break; }
        pos += len + 12;
      }
      if (!ended || !hasData) fail("INVALID_IMAGE", "PNG 缺少完整像素数据");
    } else if (mimeType === "image/jpeg") {
      if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) fail("INVALID_IMAGE", "JPEG 数据不完整");
      var at = 2;
      while (at < bytes.length - 1) {
        if (bytes[at++] !== 255) fail("INVALID_IMAGE", "JPEG 标记无效");
        while (bytes[at] === 255) at++;
        var marker = bytes[at++];
        if (marker === 218 || marker === 217) break;
        if (marker === 1 || marker >= 208 && marker <= 215) continue;
        var size = bytes[at] * 256 + bytes[at + 1];
        if (size < 2 || at + size > bytes.length) fail("INVALID_IMAGE", "JPEG 标记长度无效");
        if ([192, 193, 194].indexOf(marker) >= 0) { height = bytes[at + 3] * 256 + bytes[at + 4]; width = bytes[at + 5] * 256 + bytes[at + 6]; break; }
        at += size;
      }
      if (!width || !height) fail("UNSUPPORTED_FORMAT", "JPEG 编码格式不受当前生产路径支持");
    } else fail("UNSUPPORTED_FORMAT", "Photoshop 生产回写暂支持 PNG/JPEG；WebP 尚未验证");
    dimensions(width, height); return { width: width, height: height };
  }
  // SHA-256 keeps a bounded idempotency ledger without retaining image base64 per mutation.
  function sha256(input) {
    var bytes = input;
    if (typeof input === "string") { var utf8 = unescape(encodeURIComponent(input)); bytes = new Uint8Array(utf8.length); for (var bIndex = 0; bIndex < utf8.length; bIndex++) bytes[bIndex] = utf8.charCodeAt(bIndex); }
    var constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64), words = new Uint32Array(64);
    padded.set(bytes); padded[bytes.length] = 128; write32(padded, padded.length - 8, Math.floor(bytes.length / 0x20000000)); write32(padded, padded.length - 4, bytes.length * 8);
    function rotate(x, n) { return x >>> n | x << 32 - n; }
    for (var offset = 0; offset < padded.length; offset += 64) {
      for (var i = 0; i < 16; i++) words[i] = u32(padded, offset + i * 4);
      for (i = 16; i < 64; i++) { var x = words[i - 15], y = words[i - 2]; words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10); }
      var a = hash[0], b = hash[1], c = hash[2], d = hash[3], e = hash[4], f = hash[5], g = hash[6], h = hash[7];
      for (i = 0; i < 64; i++) { var t1 = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + (e & f ^ ~e & g) + constants[i] + words[i], t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + (a & b ^ a & c ^ b & c); h = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0; }
      [a,b,c,d,e,f,g,h].forEach(function (v, index) { hash[index] = hash[index] + v | 0; });
    }
    return hash.map(function (v) { return (v >>> 0).toString(16).padStart(8, "0"); }).join("");
  }
  module.exports = { encodePNG: encodePNG, inspectImage: inspectImage, dimensions: dimensions, sha256: sha256, MAX_PIXELS: MAX_PIXELS, MAX_BYTES: MAX_BYTES };
})();
