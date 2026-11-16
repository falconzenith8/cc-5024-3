// Minimal uncompressed TIFF reader/writer for scientific grayscale rasters.
// Supports 8/16/32/64-bit unsigned, 8/16/32-bit signed and 32/64-bit IEEE
// float, single sample per pixel, strips (one or many), either byte order.
// Compressed TIFFs are rejected explicitly rather than guessed at.

const TYPE_BYTES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readValues(dv, type, count, offset, littleEndian) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = offset + i * TYPE_BYTES[type];
    switch (type) {
      case 1: out.push(dv.getUint8(o)); break;
      case 3: out.push(dv.getUint16(o, littleEndian)); break;
      case 4: out.push(dv.getUint32(o, littleEndian)); break;
      case 6: out.push(dv.getInt8(o)); break;
      case 8: out.push(dv.getInt16(o, littleEndian)); break;
      case 9: out.push(dv.getInt32(o, littleEndian)); break;
      default: throw new Error(`Unsupported TIFF tag value type ${type}`);
    }
  }
  return out;
}

function readTagValue(dv, entry, littleEndian) {
  const type = dv.getUint16(entry + 2, littleEndian);
  const count = dv.getUint32(entry + 4, littleEndian);
  const byteLength = TYPE_BYTES[type] * count;
  if (byteLength === undefined) throw new Error(`Unsupported TIFF field type ${type}`);
  const valueOffset = byteLength <= 4 ? entry + 8 : dv.getUint32(entry + 8, littleEndian);
  if (type === 2) {
    let s = '';
    for (let i = 0; i < count; i++) s += String.fromCharCode(dv.getUint8(valueOffset + i));
    return s;
  }
  const vals = readValues(dv, type, count, valueOffset, littleEndian);
  return vals.length === 1 ? vals[0] : vals;
}

/** Read the first image of an uncompressed TIFF. */
export function parseTiff(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 8) throw new Error('File is too short to be a TIFF');
  let littleEndian;
  if (bytes[0] === 0x49 && bytes[1] === 0x49) littleEndian = true;
  else if (bytes[0] === 0x4d && bytes[1] === 0x4d) littleEndian = false;
  else throw new Error('Not a TIFF file (bad byte-order mark)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint16(2, littleEndian);
  if (magic !== 42) throw new Error(`Not a classic TIFF (magic ${magic})`);
  const ifdOffset = dv.getUint32(4, littleEndian);
  if (ifdOffset + 2 > bytes.length) throw new Error('TIFF IFD offset is out of range');
  const entryCount = dv.getUint16(ifdOffset, littleEndian);
  const tags = new Map();
  for (let i = 0; i < entryCount; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > bytes.length) throw new Error('Truncated TIFF IFD');
    const tag = dv.getUint16(entry, littleEndian);
    tags.set(tag, readTagValue(dv, entry, littleEndian));
  }

  const width = tags.get(256);
  const height = tags.get(257);
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('TIFF is missing ImageWidth/ImageLength');
  }
  const compression = tags.get(259) ?? 1;
  if (compression !== 1) {
    throw new Error(
      `Compressed TIFF (Compression=${compression}) is not supported; export an uncompressed float TIFF`,
    );
  }
  const samplesPerPixel = tags.get(277) ?? 1;
  if (samplesPerPixel !== 1) {
    throw new Error(`Only single-channel TIFF is supported, got SamplesPerPixel=${samplesPerPixel}`);
  }
  const planar = tags.get(284) ?? 1;
  if (planar !== 1) throw new Error('Only PlanarConfiguration=1 is supported');
  let bits = tags.get(258) ?? 8;
  if (Array.isArray(bits)) bits = bits[0];
  const sampleFormat = tags.get(339) ?? 1;
  const fmt = Array.isArray(sampleFormat) ? sampleFormat[0] : sampleFormat;
  const key = `${fmt}:${bits}`;
  const KNOWN = {
    '1:8': { reader: 'getUint8', size: 1, kind: 'uint' },
    '1:16': { reader: 'getUint16', size: 2, kind: 'uint' },
    '1:32': { reader: 'getUint32', size: 4, kind: 'uint' },
    '2:8': { reader: 'getInt8', size: 1, kind: 'int' },
    '2:16': { reader: 'getInt16', size: 2, kind: 'int' },
    '2:32': { reader: 'getInt32', size: 4, kind: 'int' },
    '3:32': { reader: 'getFloat32', size: 4, kind: 'float' },
    '3:64': { reader: 'getFloat64', size: 8, kind: 'float' },
  };
  const info = KNOWN[key];
  if (!info) {
    throw new Error(`Unsupported TIFF sample format: SampleFormat=${fmt}, BitsPerSample=${bits}`);
  }

  const stripOffsets = toArray(tags.get(273));
  const stripByteCounts = toArray(tags.get(279));
  if (!stripOffsets || !stripByteCounts || stripOffsets.length !== stripByteCounts.length) {
    throw new Error('TIFF is missing consistent StripOffsets/StripByteCounts');
  }
  const rowsPerStrip = tags.get(278) ?? height;
  const totalPixels = width * height;
  const data = new Float64Array(totalPixels);
  let written = 0;
  for (let s = 0; s < stripOffsets.length; s++) {
    const count = stripByteCounts[s] / info.size;
    const rows = Math.min(rowsPerStrip, height - Math.floor(written / width));
    const take = Math.min(count, rows * width);
    const start = stripOffsets[s];
    if (start + take * info.size > bytes.length) throw new Error('TIFF strip data is truncated');
    const sdv = new DataView(bytes.buffer, bytes.byteOffset + start, take * info.size);
    for (let i = 0; i < take; i++) {
      data[written + i] = sdv[info.reader](i * info.size, littleEndian);
    }
    written += take;
  }
  if (written < totalPixels) {
    throw new Error(`TIFF has only ${written} of ${totalPixels} pixel values`);
  }

  return {
    data,
    width,
    height,
    dtype: `${info.kind}${bits}`,
    dtypeKind: info.kind,
    bitsPerSample: bits,
    sampleFormat: fmt,
    format: 'tiff',
    littleEndian,
    strips: stripOffsets.length,
  };
}

function toArray(v) {
  if (v === undefined) return null;
  return Array.isArray(v) ? v : [v];
}

/**
 * Write a single-channel uncompressed TIFF. Supports float32, float64, uint8,
 * uint16 and int32 output.
 */
export function writeTiff(values, width, height, opts = {}) {
  const { dtype = 'float32', description = '' } = opts;
  const FORMATS = {
    float32: { bits: 32, sampleFormat: 3, size: 4, write: (dv, o, v) => dv.setFloat32(o, v, true) },
    float64: { bits: 64, sampleFormat: 3, size: 8, write: (dv, o, v) => dv.setFloat64(o, v, true) },
    uint8: { bits: 8, sampleFormat: 1, size: 1, write: (dv, o, v) => dv.setUint8(o, v) },
    uint16: { bits: 16, sampleFormat: 1, size: 2, write: (dv, o, v) => dv.setUint16(o, v, true) },
    int32: { bits: 32, sampleFormat: 2, size: 4, write: (dv, o, v) => dv.setInt32(o, v, true) },
  };
  const info = FORMATS[dtype];
  if (!info) throw new Error(`Unsupported TIFF output dtype: ${dtype}`);
  if (values.length !== width * height) throw new Error('TIFF pixel count mismatch');

  const pixelBytes = width * height * info.size;
  let descText = description ? description + '\0' : '';
  // Keep the ASCII tag longer than 4 bytes so it is stored out-of-line.
  while (descText && descText.length < 5) descText += ' ';
  const descBytes = descText ? new TextEncoder().encode(descText) : null;

  const entries = [];
  const add = (tag, type, count, value) => entries.push({ tag, type, count, value });

  add(256, 4, 1, width); // ImageWidth
  add(257, 4, 1, height); // ImageLength
  add(258, 3, 1, info.bits); // BitsPerSample
  add(259, 3, 1, 1); // Compression = none
  add(262, 3, 1, 1); // Photometric = BlackIsZero
  add(273, 4, 1, 0); // StripOffsets (patched)
  add(277, 3, 1, 1); // SamplesPerPixel
  add(278, 4, 1, height); // RowsPerStrip
  add(279, 4, 1, pixelBytes); // StripByteCounts
  add(284, 3, 1, 1); // PlanarConfiguration
  add(339, 3, 1, info.sampleFormat); // SampleFormat
  if (descBytes) add(270, 2, descBytes.length, 0); // ImageDescription (patched)

  entries.sort((a, b) => a.tag - b.tag);
  const ifdSize = 2 + entries.length * 12 + 4;
  const pixelOffset = 8 + ifdSize;
  const descOffset = pixelOffset + pixelBytes;
  const total = descOffset + (descBytes ? descBytes.length : 0);

  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  let pos = 10;
  for (const e of entries) {
    dv.setUint16(pos, e.tag, true);
    dv.setUint16(pos + 2, e.type, true);
    dv.setUint32(pos + 4, e.count, true);
    let value = e.value;
    if (e.tag === 273) value = pixelOffset;
    if (e.tag === 270) value = descOffset;
    const inlineSize = TYPE_BYTES[e.type] * e.count;
    if (inlineSize <= 4) {
      if (e.type === 3) dv.setUint16(pos + 8, value, true);
      else if (e.type === 4) dv.setUint32(pos + 8, value, true);
      else bytes[pos + 8] = value & 0xff;
    } else {
      dv.setUint32(pos + 8, value, true);
    }
    pos += 12;
  }
  dv.setUint32(pos, 0, true); // no next IFD
  const pixelDv = new DataView(buffer, pixelOffset, pixelBytes);
  for (let i = 0; i < values.length; i++) {
    info.write(pixelDv, i * info.size, values[i]);
  }
  if (descBytes) bytes.set(descBytes, descOffset);
  return bytes;
}

/** Detect and parse either NPY or TIFF bytes. */
export function detectFormat(bytes) {
  if (bytes.length >= 6 && bytes[0] === 0x93 && bytes[1] === 0x4e && bytes[2] === 0x55 &&
      bytes[3] === 0x4d && bytes[4] === 0x50 && bytes[5] === 0x59) {
    return 'npy';
  }
  if (bytes.length >= 4) {
    const le = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
    const be = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
    if (le || be) return 'tiff';
  }
  return null;
}
