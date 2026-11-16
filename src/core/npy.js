// Minimal, dependency-free NumPy .npy reader/writer for 2-D numeric arrays.
// Works identically in Node and browsers (Uint8Array + DataView only).

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];

const DTYPE_INFO = {
  b1: { kind: 'bool', bytes: 1, read: (dv, o) => (dv.getUint8(o) !== 0 ? 1 : 0) },
  i1: { kind: 'int', bytes: 1, read: (dv, o) => dv.getInt8(o) },
  u1: { kind: 'uint', bytes: 1, read: (dv, o) => dv.getUint8(o) },
  i2: { kind: 'int', bytes: 2, read: (dv, o, le) => dv.getInt16(o, le) },
  u2: { kind: 'uint', bytes: 2, read: (dv, o, le) => dv.getUint16(o, le) },
  i4: { kind: 'int', bytes: 4, read: (dv, o, le) => dv.getInt32(o, le) },
  u4: { kind: 'uint', bytes: 4, read: (dv, o, le) => dv.getUint32(o, le) },
  i8: { kind: 'int', bytes: 8, read: (dv, o, le) => Number(dv.getBigInt64(o, le)) },
  u8: { kind: 'uint', bytes: 8, read: (dv, o, le) => Number(dv.getBigUint64(o, le)) },
  f2: { kind: 'float', bytes: 2, read: (dv, o, le) => readFloat16(dv, o, le) },
  f4: { kind: 'float', bytes: 4, read: (dv, o, le) => dv.getFloat32(o, le) },
  f8: { kind: 'float', bytes: 8, read: (dv, o, le) => dv.getFloat64(o, le) },
};

function readFloat16(dv, offset, littleEndian) {
  const h = dv.getUint16(offset, littleEndian);
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 0x1f) return frac === 0 ? sign * Infinity : NaN;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

function parseHeader(text) {
  const descr = /'descr'\s*:\s*'([^']*)'/.exec(text);
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(text);
  const shape = /'shape'\s*:\s*\(([^)]*)\)/.exec(text);
  if (!descr || !fortran || !shape) {
    throw new Error('NPY header is missing descr, fortran_order or shape');
  }
  const shapeDims = shape[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid NPY dimension: ${s}`);
      return n;
    });
  return {
    descr: descr[1],
    fortranOrder: fortran[1] === 'True',
    shape: shapeDims,
  };
}

/** Parse a .npy file into { data: Float64Array, width, height, dtype, ... }. */
export function parseNpy(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 10) throw new Error('File is too short to be a .npy file');
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('Not a .npy file (bad magic bytes)');
  }
  const major = bytes[6];
  const minor = bytes[7];
  let headerLen;
  let headerStart;
  if (major === 1) {
    headerLen = bytes[8] | (bytes[9] << 8);
    headerStart = 10;
  } else if (major === 2 || major === 3) {
    if (bytes.length < 12) throw new Error('Truncated .npy header');
    headerLen = (bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24)) >>> 0;
    headerStart = 12;
  } else {
    throw new Error(`Unsupported .npy version ${major}.${minor}`);
  }
  const headerEnd = headerStart + headerLen;
  if (headerEnd > bytes.length) throw new Error('Truncated .npy header');
  const headerText = new TextDecoder('latin1').decode(bytes.subarray(headerStart, headerEnd));
  const { descr, fortranOrder, shape } = parseHeader(headerText);

  let endianChar = descr[0];
  let typeKey = descr.slice(1);
  if (endianChar !== '<' && endianChar !== '>' && endianChar !== '=' && endianChar !== '|') {
    typeKey = descr; // e.g. 'f4' without byte-order marker
    endianChar = '=';
  }
  const info = DTYPE_INFO[typeKey];
  if (!info) throw new Error(`Unsupported NPY dtype: ${descr}`);
  const littleEndian = endianChar !== '>';
  if (info.kind !== 'float' && info.kind !== 'int' && info.kind !== 'uint' && info.kind !== 'bool') {
    throw new Error(`Unsupported NPY dtype: ${descr}`);
  }

  // Collapse singleton dims to (rows, cols). A 1x1 image must stay 2-D even
  // though both of its dimensions equal 1.
  const dims = shape.length === 2 ? shape.slice()
    : shape.length === 3 || shape.length === 4
      ? shape.filter((d) => d !== 1)
      : shape.slice();
  if (dims.length !== 2) {
    throw new Error(`Expected a 2-D image array, got shape (${shape.join(', ')})`);
  }
  const height = dims[0];
  const width = dims[1];
  const count = width * height;
  const expected = count * info.bytes;
  const dataStart = headerEnd;
  if (dataStart + expected > bytes.length) {
    throw new Error(
      `Truncated .npy data: need ${expected} bytes, have ${bytes.length - dataStart}`,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset + dataStart, expected);
  const data = new Float64Array(count);
  const rowDim = height;
  const colDim = width;
  if (fortranOrder) {
    for (let c = 0; c < colDim; c++) {
      for (let r = 0; r < rowDim; r++) {
        const src = c * rowDim + r;
        data[r * colDim + c] = info.read(dv, src * info.bytes, littleEndian);
      }
    }
  } else {
    for (let i = 0; i < count; i++) {
      data[i] = info.read(dv, i * info.bytes, littleEndian);
    }
  }
  return {
    data,
    width,
    height,
    dtype: descr,
    dtypeKind: info.kind,
    bytesPerElement: info.bytes,
    fortranOrder,
    shape,
  };
}

/** Serialize a 2-D array to .npy bytes. Only float32/float64 are produced. */
export function writeNpy(values, width, height, dtype = 'float64') {
  if (values.length !== width * height) {
    throw new Error(`Array length ${values.length} does not match ${width}x${height}`);
  }
  let descr;
  let bytesPerElement;
  if (dtype === 'float32') {
    descr = '<f4';
    bytesPerElement = 4;
  } else if (dtype === 'float64') {
    descr = '<f8';
    bytesPerElement = 8;
  } else {
    throw new Error(`Unsupported output dtype: ${dtype}`);
  }
  const headerTextOriginal =
    `{'descr': '${descr}', 'fortran_order': False, 'shape': (${height}, ${width}), }`;
  // Pad so that magic(6) + version(2) + len(2) + header is a multiple of 64.
  const preamble = 10;
  let padded = headerTextOriginal;
  while ((preamble + padded.length + 1) % 64 !== 0) padded += ' ';
  padded += '\n';
  if (padded.length > 0xffff) {
    throw new Error('NPY header too large for version 1.0');
  }
  const total =
    preamble + padded.length + width * height * bytesPerElement;
  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  bytes.set(MAGIC, 0);
  bytes[6] = 1;
  bytes[7] = 0;
  bytes[8] = padded.length & 0xff;
  bytes[9] = (padded.length >> 8) & 0xff;
  const headerBytes = new TextEncoder().encode(padded);
  bytes.set(headerBytes, preamble);
  const dv = new DataView(buffer, preamble + padded.length);
  if (dtype === 'float32') {
    for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i], true);
  } else {
    for (let i = 0; i < values.length; i++) dv.setFloat64(i * 8, values[i], true);
  }
  return bytes;
}

export const NPY_MAGIC = MAGIC;
