#!/usr/bin/env node
// Generates reproducible fixture cases under cases/. Each case is synthetic
// and carries a known reference value, so results can be recomputed without
// any private data. No biological meaning is implied by these fields.

import fs from 'node:fs';
import path from 'node:path';
import { writeNpy } from '../src/core/npy.js';
import { writeTiff } from '../src/core/tiff.js';
import { createMask, maskFromShapes } from '../src/core/mask.js';

const OUT = path.join(process.cwd(), 'cases');

// Honour SOURCE_DATE_EPOCH for reproducible fixture metadata; fall back to
// the current time only for ad-hoc local regeneration.
const timestamp = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : new Date().toISOString();

function writeCase(name, description, generator) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  const spec = generator();
  fs.writeFileSync(path.join(dir, 'values.npy'), writeNpy(spec.values, spec.width, spec.height, 'float64'));
  if (spec.mask) {
    const m = new Float64Array(spec.mask.length);
    for (let i = 0; i < m.length; i++) m[i] = spec.mask[i] ? 1 : 0;
    fs.writeFileSync(path.join(dir, 'mask.npy'), writeNpy(m, spec.width, spec.height, 'float64'));
  }
  const meta = {
    case: name,
    description,
    synthetic: true,
    width: spec.width,
    height: spec.height,
    maskPresent: Boolean(spec.mask),
    expected: spec.expected,
    gridSuggestion: spec.gridSuggestion,
    semanticsSuggestion: spec.semanticsSuggestion,
    createdAt: timestamp,
  };
  fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

const cases = [];

// 1. Constant field: any grid must return the same constant with full coverage.
cases.push(writeCase('constant-field', 'Uniform intensity 12.5 on 16x16. Resampling any grid must return 12.5 exactly with coverage 1 where a cell is fully inside the source.', () => {
  const w = 16;
  const h = 16;
  const values = new Float64Array(w * h).fill(12.5);
  return {
    width: w, height: h, values,
    gridSuggestion: { width: 7, height: 5 },
    semanticsSuggestion: 'mean',
    expected: {
      allValidCellsIntensity: 12.5,
      allValidCellsCoverage: 1,
      note: 'NaN only for every cell with coverage 0.',
    },
  };
}));

// 2. Known integral spot: discrete Gaussian with an exactly computable total.
cases.push(writeCase('known-integral-spot', 'Discrete Gaussian spot on 32x32 centered at (15.5,15.5), sigma=3.5, peak 1000. Sum mode at 64x64 must reproduce the discrete total.', () => {
  const w = 32;
  const h = 32;
  const values = new Float64Array(w * h);
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 1000 * Math.exp(-((x - 15.5) ** 2 + (y - 15.5) ** 2) / (2 * 3.5 ** 2));
      values[y * w + x] = v;
      total += v;
    }
  }
  return {
    width: w, height: h, values,
    gridSuggestion: { width: 64, height: 64 },
    semanticsSuggestion: 'sum',
    expected: { discreteTotal: total, toleranceRelative: 1e-12 },
  };
}));

// 3. Partial mask: an annular valid region plus masked-out non-zero pixels.
cases.push(writeCase('partial-mask', 'Ramp 0..100 over 24x24 with an invalid circular hole and a masked-out corner. Coverage must be reported per cell; missing cells are NaN.', () => {
  const w = 24;
  const h = 24;
  const values = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      values[y * w + x] = (x / (w - 1)) * 100 + (y / (h - 1)) * 10;
    }
  }
  const mask = maskFromShapes(w, h, [
    { type: 'ellipse', cx: 12, cy: 12, rx: 6, ry: 4 },
    { type: 'rect', x0: 18, y0: 0, x1: 24, y1: 5 },
  ]);
  return {
    width: w, height: h, values, mask,
    gridSuggestion: { width: 8, height: 8 },
    semanticsSuggestion: 'mean',
    expected: {
      note: 'Cells overlapping the hole or the corner must have coverage < 1. Fully empty cells must be NaN. The mean of any cell uses only valid samples, never a filled-in zero.',
    },
  };
}));

// 4. Extreme dynamic range: values spanning ~1e-12..1e6 with true zeros.
cases.push(writeCase('extreme-dynamic-range', 'Field spanning 1e-12 to 1e6, including exact zeros and a few NaN pixels. Tests that no FLOAT32 conversion happens before statistics.', () => {
  const w = 20;
  const h = 20;
  const values = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (i % 11 === 0) values[i] = 1e-12;
      else if (i % 13 === 0) values[i] = 1e6;
      else if (i % 7 === 0) values[i] = 0;
      else if (i % 17 === 0) values[i] = NaN;
      else values[i] = 10 ** (((x * 7 + y * 3) % 25) - 12);
    }
  }
  return {
    width: w, height: h, values,
    gridSuggestion: { width: 6, height: 6 },
    semanticsSuggestion: 'mean',
    expected: {
      note: 'Rendered through the display layer may clip; the saved data must not.',
      validTrueZerosPresent: true,
      nanPresent: true,
    },
  };
}));

// 5. True zero vs missing trap: a cell with half real zeros, half masked.
cases.push(writeCase('zero-vs-missing', 'Left half is real zeros, right half is masked non-zero values. A cell spanning both must average to 0 (real zero), coverage 0.5, not 0.5*value.', () => {
  const w = 8;
  const h = 4;
  const values = new Float64Array(w * h);
  const mask = createMask(w, h, 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < 4) values[i] = 0;
      else { values[i] = 100; mask[i] = 0; }
    }
  }
  return {
    width: w, height: h, values, mask,
    gridSuggestion: { width: 1, height: 1 },
    semanticsSuggestion: 'mean',
    expected: {
      cell0Intensity: 0,
      cell0Coverage: 0.5,
    },
  };
}));

// 6. Float32 round-trip reference TIFF, to exercise TIFF input in the GUI.
cases.push(writeCase('float32-tiff', 'Same spot field saved as uncompressed float32 TIFF for testing TIFF loading. Values are quantized to float32, which is recorded as a known precision limit.', () => {
  const w = 24;
  const h = 24;
  const values = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      values[y * w + x] = 500 * Math.exp(-((x - 11.5) ** 2 + (y - 11.5) ** 2) / 20) + 2.5;
    }
  }
  // Write a parallel float32 TIFF (the .npy stays float64 for recomputation).
  return {
    width: w, height: h, values,
    gridSuggestion: { width: 12, height: 12 },
    semanticsSuggestion: 'mean',
    expected: { note: 'TIFF loading quantizes to float32; use the .npy for exact recomputation.' },
  };
}));

// Write the float32 TIFF for case 6 explicitly.
{
  const dir = path.join(OUT, 'float32-tiff');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  const npyBytes = fs.readFileSync(path.join(dir, 'values.npy'));
  const { parseNpy } = await import('../src/core/npy.js');
  const arr = parseNpy(npyBytes);
  fs.writeFileSync(
    path.join(dir, 'values-float32.tiff'),
    writeTiff(arr.data, arr.width, arr.height, {
      dtype: 'float32',
      description: 'Synthetic quantitative float resampling fixture; not biological data.',
    }),
  );
  meta.files = ['values.npy', 'values-float32.tiff', 'case.json'];
  fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify(meta, null, 2) + '\n');
}

// Overview file
fs.writeFileSync(
  path.join(OUT, 'README.json'),
  JSON.stringify(
    {
      note:
        'All cases are synthetic. They exercise resampling behaviour only and support no biological interpretation.',
      generatedAt: timestamp,
      cases: cases.map((c) => ({
        name: c.case,
        description: c.description,
        width: c.width,
        height: c.height,
        maskPresent: c.maskPresent,
        gridSuggestion: c.gridSuggestion,
        semanticsSuggestion: c.semanticsSuggestion,
      })),
    },
    null,
    2,
  ) + '\n',
);

console.log(`generated ${cases.length} cases in ${OUT}`);
