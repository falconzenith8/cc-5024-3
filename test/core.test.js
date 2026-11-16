import test from 'node:test';
import assert from 'node:assert/strict';
import { resample } from '../src/core/resample.js';
import { referenceResampleExact, referenceResample, maxAbsDiff } from '../src/core/reference.js';

function constantField(w, h, v) {
  const a = new Float64Array(w * h);
  a.fill(v);
  return a;
}

test('constant field: any grid reproduces the constant, full coverage', () => {
  const w = 7;
  const h = 5;
  const values = constantField(w, h, 3.25);
  const result = resample({
    values, width: w, height: h,
    grid: { width: 3, height: 4 },
  });
  for (let i = 0; i < result.intensity.length; i++) {
    assert.ok(Math.abs(result.intensity[i] - 3.25) < 1e-12, `cell ${i}`);
    assert.ok(Math.abs(result.coverage[i] - 1) < 1e-12, `coverage ${i}`);
  }
  assert.equal(result.stats.validPixels, w * h);
  assert.equal(result.stats.undefinedCells, 0);
  assert.ok(result.stats.partitionsUsableSource);
});

test('mean vs sum differ by footprint area and are labelled distinctly', () => {
  const w = 4;
  const h = 4;
  const values = constantField(w, h, 2);
  const mean = resample({ values, width: w, height: h, grid: { width: 2, height: 2 }, mode: 'mean' });
  const sum = resample({ values, width: w, height: h, grid: { width: 2, height: 2 }, mode: 'sum' });
  assert.equal(mean.quantity, 'intensity');
  assert.equal(sum.quantity, 'integral');
  // Each 2x2 output cell covers 4 source pixels; mean stays 2, sum == 8.
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(mean.intensity[i] - 2) < 1e-12);
    assert.ok(Math.abs(sum.intensity[i] - 8) < 1e-12);
  }
  assert.ok(Math.abs(sum.stats.outputIntegral - 32) < 1e-12);
  assert.ok(sum.stats.integralConserved);
  assert.equal(mean.stats.integralConserved, false);
});

test('known integral spot: total intensity is reproduced under sum mode', () => {
  const w = 32;
  const h = 32;
  const values = new Float64Array(w * h);
  // A symmetric Gaussian-ish spot with an exactly known discrete total.
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d2 = (x - 15.5) ** 2 + (y - 15.5) ** 2;
      const v = 1000 * Math.exp(-d2 / (2 * 3.5 ** 2));
      values[y * w + x] = v;
      total += v;
    }
  }
  // Upsample to 64x64, sum mode: the total must match because footprints
  // partition the usable source exactly (area units of 0.5x0.5).
  const result = resample({
    values, width: w, height: h,
    grid: { width: 64, height: 64 },
    mode: 'sum',
  });
  const err = Math.abs(result.stats.outputIntegral - total) / total;
  assert.ok(err < 1e-12, `relative integral error ${err}`);
  assert.ok(result.stats.integralConserved);
});

test('downsample sum conserves total; downsample mean does not claim to', () => {
  const w = 16;
  const h = 16;
  const values = new Float64Array(w * h);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] = (i * 37) % 101;
    total += values[i];
  }
  const result = resample({ values, width: w, height: h, grid: { width: 4, height: 4 }, mode: 'sum' });
  assert.ok(Math.abs(result.stats.outputIntegral - total) < 1e-9);
  assert.ok(result.stats.integralConserved);
  const mean = resample({ values, width: w, height: h, grid: { width: 4, height: 4 }, mode: 'mean' });
  assert.equal(mean.stats.integralConserved, false);
});

test('partial mask: coverage is area fraction, missing cells are NaN not zero', () => {
  const w = 4;
  const h = 4;
  const values = constantField(w, h, 10);
  const mask = new Uint8Array(w * h).fill(1);
  // Mask out the left half.
  for (let y = 0; y < h; y++) for (let x = 0; x < 2; x++) mask[y * w + x] = 0;
  const result = resample({ values, mask, width: w, height: h, grid: { width: 2, height: 1 } });
  // Output cell 0 covers masked half -> no usable samples -> NaN, coverage 0.
  assert.ok(Number.isNaN(result.intensity[0]));
  assert.equal(result.coverage[0], 0);
  assert.ok(Number.isNaN(result.intensity[0]) && result.intensity[0] !== 0);
  // Output cell 1 fully usable -> 10, coverage 1.
  assert.ok(Math.abs(result.intensity[1] - 10) < 1e-12);
  assert.ok(Math.abs(result.coverage[1] - 1) < 1e-12);
  assert.equal(result.stats.undefinedCells, 1);
  assert.ok(result.anomalies.some((a) => a.code === 'UNDEFINED_OUTPUT_CELLS'));
});

test('half-covered cell: mean uses only valid samples and reports 0.5 coverage', () => {
  const w = 2;
  const h = 1;
  const values = new Float64Array([100, 0]);
  // pixel 1 is masked out; its true value is irrelevant, but set 0 to prove
  // we do not let a zero from an invalid pixel dilute the mean.
  const mask = new Uint8Array([1, 0]);
  const result = resample({ values, mask, width: w, height: h, grid: { width: 1, height: 1 } });
  assert.ok(Math.abs(result.intensity[0] - 100) < 1e-12, 'mean must be 100, not 50');
  assert.ok(Math.abs(result.coverage[0] - 0.5) < 1e-12);
});

test('true zero vs missing are distinguished', () => {
  const w = 2;
  const h = 1;
  // Pixel 0: valid true zero. Pixel 1: masked out with value 5.
  const values = new Float64Array([0, 5]);
  const mask = new Uint8Array([1, 0]);
  const result = resample({ values, mask, width: w, height: h, grid: { width: 1, height: 1 } });
  assert.equal(result.stats.validTrueZeros, 1);
  assert.equal(result.intensity[0], 0, 'a real zero must yield zero, not NaN');
  assert.ok(Math.abs(result.coverage[0] - 0.5) < 1e-12);
  assert.equal(result.stats.excludedNonZero, 1);
});

test('NaN in an included pixel is treated as missing, and flagged', () => {
  const w = 2;
  const h = 1;
  const values = new Float64Array([4, NaN]);
  const mask = new Uint8Array([1, 1]);
  const result = resample({ values, mask, width: w, height: h, grid: { width: 1, height: 1 } });
  assert.ok(Math.abs(result.intensity[0] - 4) < 1e-12);
  assert.ok(Math.abs(result.coverage[0] - 0.5) < 1e-12);
  assert.ok(result.anomalies.some((a) => a.code === 'NONFINITE_MARKED_VALID'));
});

test('mask=null means all finite pixels usable; NaN still missing', () => {
  const values = new Float64Array([1, NaN, 3, 5]);
  const result = resample({ values, width: 2, height: 2, grid: { width: 1, height: 1 } });
  assert.ok(Math.abs(result.intensity[0] - 3) < 1e-12);
  assert.ok(Math.abs(result.coverage[0] - 0.75) < 1e-12);
});

test('partial extent is not claimed as conserved in sum mode', () => {
  const w = 8;
  const h = 8;
  const values = constantField(w, h, 2);
  const result = resample({
    values, width: w, height: h,
    grid: { width: 2, height: 2, extent: [0, 0, 4, 4] },
    mode: 'sum',
  });
  assert.equal(result.stats.integralConserved, false);
  assert.ok(result.anomalies.some((a) => a.code === 'NON_PARTITIONING_GRID'));
});

test('fractional pixel offset: area weights split a pixel proportionally', () => {
  const w = 3;
  const h = 1;
  const values = new Float64Array([1, 1, 1]);
  // Extent 0.5..2.5 split into 2 cells of width 1: cell 0 gets 0.5 of px0 and
  // 0.5 of px1; cell 1 gets 0.5 of px1 and 0.5 of px2.
  const result = resample({
    values, width: w, height: h,
    grid: { width: 2, height: 1, extent: [0.5, 0, 2.5, 1] },
  });
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(result.intensity[i] - 1) < 1e-12);
    assert.ok(Math.abs(result.coverage[i] - 1) < 1e-12);
  }
});

test('extreme dynamic range keeps double precision and does not overflow mean', () => {
  const values = new Float64Array([1e-300, 1e300, 5e-200, 5e200]);
  const result = resample({ values, width: 2, height: 2, grid: { width: 1, height: 1 } });
  const expected = (1e-300 + 1e300 + 5e-200 + 5e200) / 4;
  assert.ok(Math.abs(result.intensity[0] - expected) / expected < 1e-15);
  // Sum mode with extreme values: finite because they fit, and the relative
  // error versus a Kahan-style reference stays tiny.
  const sum = resample({ values, width: 2, height: 2, grid: { width: 1, height: 1 }, mode: 'sum' });
  const expectedSum = 1e-300 + 1e300 + 5e-200 + 5e200;
  assert.ok(Math.abs(sum.intensity[0] - expectedSum) / expectedSum < 1e-15);
});

test('mean is robust when a single huge value would overflow a naive total', () => {
  const values = new Float64Array([1, 1, 1, 1e308]);
  const result = resample({ values, width: 2, height: 2, grid: { width: 1, height: 1 } });
  assert.ok(Number.isFinite(result.intensity[0]));
  assert.equal(result.stats.undefinedCells, 0);
});

test('reference agreement: exact scatter reference on all field/mask/grid combos', () => {
  const w = 11;
  const h = 9;
  const masks = [
    null,
    (() => {
      const m = new Uint8Array(w * h).fill(1);
      for (let i = 0; i < m.length; i++) if (i % 3 === 0) m[i] = 0;
      return m;
    })(),
  ];
  const fields = {
    constant: constantField(w, h, 7),
    ramp: Float64Array.from({ length: w * h }, (_, i) => (i % w) * 2 + Math.floor(i / w) * 0.5),
    spot: Float64Array.from({ length: w * h }, (_, i) => {
      const x = i % w;
      const y = Math.floor(i / w);
      return Math.exp(-((x - 5) ** 2 + (y - 4) ** 2) / 6);
    }),
  };
  const grids = [
    { width: 5, height: 4 },
    { width: 17, height: 13 },
    { width: 6, height: 3, extent: [1.25, 0.75, 9.5, 7.25] },
  ];
  for (const [name, values] of Object.entries(fields)) {
    for (const mask of masks) {
      for (const grid of grids) {
        for (const mode of ['mean', 'sum']) {
          const got = resample({ values, width: w, height: h, mask, grid, mode });
          const ref = referenceResampleExact({
            values, width: w, height: h, mask,
            outWidth: grid.width, outHeight: grid.height,
            extent: grid.extent || [0, 0, w, h], mode,
          });
          const err = maxAbsDiff(got.intensity, ref.intensity);
          assert.ok(Number.isFinite(err) && err < 1e-10,
            `${name} mask=${!!mask} mode=${mode} grid=${grid.width}x${grid.height}: err=${err}`);
          const covErr = maxAbsDiff(got.coverage, ref.coverage);
          assert.ok(covErr < 1e-10, `${name} coverage err=${covErr}`);
        }
      }
    }
  }
});

test('dense quadrature agrees on smooth fields away from mask edges', () => {
  const w = 20;
  const h = 20;
  const values = Float64Array.from({ length: w * h }, (_, i) => {
    const x = i % w;
    const y = Math.floor(i / w);
    return Math.sin(x / 7) + Math.cos(y / 5) + 3;
  });
  const grid = { width: 9, height: 7 };
  const got = resample({ values, width: w, height: h, grid });
  const ref = referenceResample({
    values, width: w, height: h, outWidth: 9, outHeight: 7, subSamples: 128,
  });
  const err = maxAbsDiff(got.intensity, ref.intensity);
  assert.ok(err < 1e-3, `quadrature mean err=${err}`);
  const covErr = maxAbsDiff(got.coverage, ref.coverage);
  assert.ok(covErr < 1e-12, `quadrature coverage err=${covErr}`);
});

test('invalid input combinations throw', () => {
  const values = new Float64Array(4);
  assert.throws(() => resample({ values, width: 2, height: 2, grid: { width: 1, height: 1 }, mode: 'bogus' }));
  assert.throws(() => resample({ values, width: 2, height: 2, grid: { width: 1, height: 1 }, compensate: true }));
  assert.throws(() => resample({ values, width: 3, height: 2, grid: { width: 1, height: 1 } }));
  assert.throws(() => resample({ values, width: 2, height: 2, mask: new Uint8Array(3), grid: { width: 1, height: 1 } }));
  assert.throws(() => resample({ values, width: 2, height: 2, grid: { width: 1, height: 1, extent: [0, 0, 0, 1] } }));
});

test('masked-everything reports zero valid and an error anomaly', () => {
  const values = constantField(3, 3, 1);
  const mask = new Uint8Array(9);
  const result = resample({ values, mask, width: 3, height: 3, grid: { width: 2, height: 2 } });
  assert.equal(result.stats.validPixels, 0);
  assert.ok(result.anomalies.some((a) => a.code === 'NO_VALID_SAMPLES'));
  for (let i = 0; i < 4; i++) assert.ok(Number.isNaN(result.intensity[i]));
});

test('compensate is an estimate, explicitly not conserved', () => {
  const w = 4;
  const h = 1;
  const values = constantField(w, h, 4);
  const mask = new Uint8Array([1, 1, 0, 0]);
  const raw = resample({ values, mask, width: w, height: h, grid: { width: 1, height: 1 }, mode: 'sum' });
  const comp = resample({ values, mask, width: w, height: h, grid: { width: 1, height: 1 }, mode: 'sum', compensate: true });
  assert.ok(Math.abs(raw.intensity[0] - 8) < 1e-12);
  assert.ok(Math.abs(comp.intensity[0] - 16) < 1e-12);
  assert.equal(comp.stats.integralConserved, false);
  assert.ok(comp.anomalies.some((a) => a.code === 'COVERAGE_COMPENSATED_ESTIMATE'));
});

test('precision: full float64 values survive the pipeline', () => {
  const v = 0.1 + 0.2; // 0.30000000000000004
  const result = resample({ values: new Float64Array([v]), width: 1, height: 1, grid: { width: 1, height: 1 } });
  assert.equal(result.intensity[0], v);
});
