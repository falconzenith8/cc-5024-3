import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNpy, writeNpy } from '../src/core/npy.js';
import { parseTiff, writeTiff, detectFormat } from '../src/core/tiff.js';

test('npy round-trips float64 bit-exactly', () => {
  const values = Float64Array.from([0, -0, 1e-300, 1e300, Math.PI, -2.5, NaN, Infinity, -Infinity]);
  const bytes = writeNpy(values, 3, 3, 'float64');
  const back = parseNpy(bytes);
  assert.equal(back.width, 3);
  assert.equal(back.height, 3);
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) assert.ok(Number.isNaN(back.data[i]));
    else assert.equal(back.data[i], values[i], `index ${i}`);
  }
  assert.equal(back.dtype, '<f8');
});

test('npy reader accepts big-endian and fortran order descriptors', () => {
  // Hand-build a 2x2 big-endian f4 array [[1,2],[3,4]] in C order.
  const header = "{'descr': '>f4', 'fortran_order': False, 'shape': (2, 2), }";
  const pad = 64 - ((10 + header.length + 1) % 64);
  const text = header + ' '.repeat(pad === 64 ? 0 : pad) + '\n';
  const headerLen = text.length;
  const bytes = new Uint8Array(10 + headerLen + 16);
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  bytes[8] = headerLen & 0xff;
  bytes[9] = (headerLen >> 8) & 0xff;
  bytes.set(new TextEncoder().encode(text), 10);
  const dv = new DataView(bytes.buffer);
  [1, 2, 3, 4].forEach((v, i) => dv.setFloat32(10 + headerLen + i * 4, v, false));
  const back = parseNpy(bytes);
  assert.deepEqual(Array.from(back.data), [1, 2, 3, 4]);
  assert.equal(back.fortranOrder, false);
});

test('npy rejects non-2D and malformed input', () => {
  const header = "{'descr': '<f8', 'fortran_order': False, 'shape': (2, 2, 2), }";
  const pad = 64 - ((10 + header.length + 1) % 64);
  const text = header + ' '.repeat(pad === 64 ? 0 : pad) + '\n';
  const bytes = new Uint8Array(10 + text.length + 64);
  bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  bytes[8] = text.length & 0xff;
  bytes[9] = (text.length >> 8) & 0xff;
  bytes.set(new TextEncoder().encode(text), 10);
  assert.throws(() => parseNpy(bytes), /2-D/);
  assert.throws(() => parseNpy(new Uint8Array([1, 2, 3])), /too short|bad magic/);
});

test('tiff round-trips float32 and float64 single-channel images', () => {
  const w = 5;
  const h = 4;
  const values = Float64Array.from({ length: w * h }, (_, i) => (i - 10) * 0.25);
  for (const dtype of ['float32', 'float64']) {
    const bytes = writeTiff(values, w, h, { dtype, description: 'unit test image' });
    const back = parseTiff(bytes);
    assert.equal(back.width, w);
    assert.equal(back.height, h);
    assert.equal(back.dtypeKind, 'float');
    for (let i = 0; i < values.length; i++) {
      if (dtype === 'float32') assert.ok(Math.abs(back.data[i] - values[i]) < 1e-6);
      else assert.equal(back.data[i], values[i]);
    }
  }
});

test('tiff round-trips uint8/uint16/int32', () => {
  const w = 3;
  const h = 2;
  const cases = [
    ['uint8', [0, 1, 255, 7, 8, 9]],
    ['uint16', [0, 1, 65535, 300, 400, 500]],
    ['int32', [-100, 0, 100, 2147483647, -2147483648, 5]],
  ];
  for (const [dtype, vals] of cases) {
    const bytes = writeTiff(Float64Array.from(vals), w, h, { dtype });
    const back = parseTiff(bytes);
    assert.deepEqual(Array.from(back.data), vals, dtype);
  }
});

test('tiff rejects compressed multi-channel and unsupported bit depths', () => {
  const bytes = writeTiff(new Float64Array(4), 2, 2, { dtype: 'float32' });
  // Patch Compression tag (259) value to 5 (LZW).
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (dv.getUint16(e, true) === 259) dv.setUint16(e + 8, 5, true);
  }
  assert.throws(() => parseTiff(bytes), /Compressed/);
});

test('detectFormat distinguishes npy and tiff', () => {
  assert.equal(detectFormat(writeNpy(new Float64Array(1), 1, 1)), 'npy');
  assert.equal(detectFormat(writeTiff(new Float64Array([1]), 1, 1)), 'tiff');
  assert.equal(detectFormat(new Uint8Array([1, 2, 3, 4, 5])), null);
});

test('tiff multi-strip reading works', () => {
  // Build a TIFF by hand with two strips of 1 row each.
  const w = 2;
  const h = 2;
  const rows = [[1.5, 2.5], [3.5, 4.5]];
  const stripBytes = w * 4;
  const entries = [
    [256, 4, 1, w], [257, 4, 1, h], [258, 3, 1, 32], [259, 3, 1, 1],
    [262, 3, 1, 1], [273, 4, 2, 0], [277, 3, 1, 1], [278, 4, 1, 1],
    [279, 4, 2, 0], [284, 3, 1, 1], [339, 3, 1, 3],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const extraOffset = 8 + ifdSize;
  const offsetsOffset = extraOffset;
  const countsOffset = offsetsOffset + 8;
  const dataOffset = countsOffset + 8;
  const buf = new ArrayBuffer(dataOffset + 2 * stripBytes);
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  bytes[0] = 0x49; bytes[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  let p = 10;
  for (const [tag, type, count, val] of entries) {
    dv.setUint16(p, tag, true);
    dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, count, true);
    let v = val;
    if (tag === 273) v = offsetsOffset;
    if (tag === 279) v = countsOffset;
    if (count * 2 <= 4 && type === 3) dv.setUint16(p + 8, v, true);
    else dv.setUint32(p + 8, v, true);
    p += 12;
  }
  dv.setUint32(p, 0, true);
  dv.setUint32(offsetsOffset, dataOffset, true);
  dv.setUint32(offsetsOffset + 4, dataOffset + stripBytes, true);
  dv.setUint32(countsOffset, stripBytes, true);
  dv.setUint32(countsOffset + 4, stripBytes, true);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      dv.setFloat32(dataOffset + r * stripBytes + c * 4, rows[r][c], true);
    }
  }
  const back = parseTiff(bytes);
  assert.deepEqual(Array.from(back.data), [1.5, 2.5, 3.5, 4.5]);
  assert.equal(back.strips, 2);
});
