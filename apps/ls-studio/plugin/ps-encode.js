/* PNG + base64. From wheelchair host/ps-pixels.js (encode only). */
function arrayBufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var chunks = [];
  var chunkSize = 8192;
  for (var i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}

function base64ToArrayBuffer(base64) {
  var binary = atob(base64);
  var len = binary.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function encodePNGFromRGB(w, h, rgbData, comp) {
  comp = comp || 3;
  function u32be(a, o, v) {
    a[o] = (v >>> 24) & 0xFF;
    a[o + 1] = (v >>> 16) & 0xFF;
    a[o + 2] = (v >>> 8) & 0xFF;
    a[o + 3] = v & 0xFF;
  }
  var _ct = null;
  function crc32(buf, s, len) {
    if (!_ct) {
      _ct = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _ct[n] = c;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = s; i < s + len; i++) crc = _ct[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  var rowB = 1 + w * 3, rawSz = rowB * h;
  var raw = new Uint8Array(rawSz);
  for (var y = 0; y < h; y++) {
    raw[y * rowB] = 0;
    for (var x = 0; x < w; x++) {
      var si = (y * w + x) * comp, di = y * rowB + 1 + x * 3;
      raw[di] = rgbData[si];
      raw[di + 1] = rgbData[si + 1];
      raw[di + 2] = rgbData[si + 2];
    }
  }
  var MX = 65535, nBlk = Math.ceil(rawSz / MX);
  var dfSz = 2 + nBlk * 5 + rawSz + 4;
  var df = new Uint8Array(dfSz);
  df[0] = 0x78; df[1] = 0x01;
  var p = 2;
  for (var bi = 0; bi < nBlk; bi++) {
    var bStart = bi * MX, bLen = Math.min(MX, rawSz - bStart);
    df[p++] = (bi === nBlk - 1) ? 1 : 0;
    df[p++] = bLen & 0xFF; df[p++] = (bLen >> 8) & 0xFF;
    df[p++] = (~bLen) & 0xFF; df[p++] = ((~bLen) >> 8) & 0xFF;
    df.set(raw.subarray(bStart, bStart + bLen), p);
    p += bLen;
  }
  var a1 = 1, a2 = 0;
  for (var ai = 0; ai < rawSz; ai++) { a1 = (a1 + raw[ai]) % 65521; a2 = (a2 + a1) % 65521; }
  var adl = ((a2 << 16) | a1) >>> 0;
  df[p++] = (adl >>> 24) & 0xFF; df[p++] = (adl >>> 16) & 0xFF;
  df[p++] = (adl >>> 8) & 0xFF; df[p++] = adl & 0xFF;
  var sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  var ihdr = new Uint8Array(25);
  u32be(ihdr, 0, 13); ihdr[4] = 73; ihdr[5] = 72; ihdr[6] = 68; ihdr[7] = 82;
  u32be(ihdr, 8, w); u32be(ihdr, 12, h);
  ihdr[16] = 8; ihdr[17] = 2; ihdr[18] = 0; ihdr[19] = 0; ihdr[20] = 0;
  u32be(ihdr, 21, crc32(ihdr, 4, 17));
  var idat = new Uint8Array(4 + 4 + dfSz + 4);
  u32be(idat, 0, dfSz); idat[4] = 73; idat[5] = 68; idat[6] = 65; idat[7] = 84;
  idat.set(df, 8); u32be(idat, 8 + dfSz, crc32(idat, 4, 4 + dfSz));
  var iend = new Uint8Array(12);
  u32be(iend, 0, 0); iend[4] = 73; iend[5] = 69; iend[6] = 78; iend[7] = 68;
  u32be(iend, 8, crc32(iend, 4, 4));
  var png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
  var off = 0;
  png.set(sig, off); off += sig.length;
  png.set(ihdr, off); off += ihdr.length;
  png.set(idat, off); off += idat.length;
  png.set(iend, off);
  return png;
}

var _ps = (typeof window !== "undefined" ? window.ps : null) || {};
_ps.arrayBufferToBase64 = arrayBufferToBase64;
_ps.base64ToArrayBuffer = base64ToArrayBuffer;
_ps.encodePNGFromRGB = encodePNGFromRGB;
if (typeof window !== "undefined") {
  window.ps = _ps;
  window.psEncode = {
    arrayBufferToBase64: arrayBufferToBase64,
    base64ToArrayBuffer: base64ToArrayBuffer,
    encodePNGFromRGB: encodePNGFromRGB
  };
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    arrayBufferToBase64: arrayBufferToBase64,
    base64ToArrayBuffer: base64ToArrayBuffer,
    encodePNGFromRGB: encodePNGFromRGB
  };
}
