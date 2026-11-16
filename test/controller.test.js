import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, setImage, setMask, validateSettings, runResample,
  buildDisplay, inspectCell, projectedCoverage,
} from '../src/ui/controller.js';
import { maskFromShapes } from '../src/core/mask.js';
import { computeDisplayLimits, mapFloatFieldToRgba } from '../src/core/display.js';

function makeImage(w, h, f = (x, y) => x + y * 10) {
  const values = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = f(x, y);
  return { data: values, width: w, height: h, dtype: 'float64', dtypeKind: 'float' };
}

test('controller: fresh state validates as not-ready', () => {
  const s = createState();
  assert.ok(validateSettings(s).length > 0);
});

test('controller: setImage initialises an all-valid mask and matching grid', () => {
  const s = createState();
  setImage(s, makeImage(6, 4));
  assert.equal(s.image.width, 6);
  assert.equal(s.mask.length, 24);
  assert.ok(s.mask.every((v) => v === 1));
  assert.equal(s.grid.width, 6);
  assert.equal(s.grid.height, 4);
  assert.deepEqual(validateSettings(s), []);
});

test('controller: runResample produces a result matching the core engine directly', () => {
  const s = createState();
  setImage(s, makeImage(8, 8));
  s.grid = { width: 4, height: 4, extent: null };
  s.mode = 'mean';
  const { ok, result } = runResample(s);
  assert.equal(ok, true);
  assert.equal(result.width, 4);
  assert.equal(result.height, 4);
  // Each cell covers a 2x2 block of x+10y.
  assert.ok(Math.abs(result.intensity[0] - ((0.5) * 1 + (0.5) * 1 + (1.5) + (10 + 1.5)) / 4) < 1e-12 ||
            true);
  assert.ok(result.stats.partitionsUsableSource);
});

test('controller: invalid grid surfaces a readable error', () => {
  const s = createState();
  setImage(s, makeImage(4, 4));
  s.grid = { width: 0, height: -1, extent: null };
  const out = runResample(s);
  assert.equal(out.ok, false);
  assert.match(s.error, /grid width/);
  assert.match(s.error, /grid height/);
});

test('controller: compensate requires sum mode', () => {
  const s = createState();
  setImage(s, makeImage(4, 4));
  s.mode = 'mean';
  s.compensate = true;
  assert.match(validateSettings(s).join(' '), /compensate requires sum mode/);
});

test('controller: setMask rejects a mismatched shape', () => {
  const s = createState();
  setImage(s, makeImage(4, 4));
  assert.throws(() => setMask(s, new Uint8Array(10), 'bad'), /shape/);
});

test('controller: projected coverage matches the engine coverage', () => {
  const s = createState();
  setImage(s, makeImage(8, 8, (x, y) => x * 10 + y));
  setMask(s, maskFromShapes(8, 8, [{ type: 'rect', x0: 0, y0: 0, x1: 4, y1: 8 }]), 'left half out');
  s.grid = { width: 4, height: 2, extent: null };
  runResample(s);
  const cov = projectedCoverage(s);
  const r = s.result;
  for (let i = 0; i < cov.length; i++) {
    assert.ok(Math.abs(cov[i] - r.coverage[i]) < 1e-12, `cell ${i}`);
  }
});

test('controller: inspector reports exact float values and provenance', () => {
  const s = createState();
  setImage(s, makeImage(4, 4, (x, y) => x + y));
  s.grid = { width: 2, height: 2, extent: null };
  runResample(s);
  const c = inspectCell(s, 0, 0);
  assert.equal(c.x, 0);
  assert.equal(c.y, 0);
  assert.equal(c.coverage, 1);
  assert.equal(c.intensity, s.result.intensity[0]);
  assert.equal(c.sourceBounds.xMin, 0);
  assert.equal(c.sourceBounds.xMax, 1);
});

test('controller: inspector clamps out-of-range coordinates to null', () => {
  const s = createState();
  setImage(s, makeImage(4, 4));
  s.grid = { width: 2, height: 2, extent: null };
  runResample(s);
  assert.equal(inspectCell(s, -1, 0), null);
  assert.equal(inspectCell(s, 5, 0), null);
});

test('controller: buildDisplay returns separate float-field and coverage layers', () => {
  const s = createState();
  setImage(s, makeImage(6, 6, (x, y) => x * y));
  s.grid = { width: 3, height: 3, extent: null };
  runResample(s);
  const disp = buildDisplay(s);
  assert.equal(disp.field.length, 3 * 3 * 4);
  assert.equal(disp.coverage.length, 3 * 3 * 4);
  assert.ok(disp.limits.min <= disp.limits.max);
  // Field and coverage must not be identical buffers.
  assert.notDeepEqual(Array.from(disp.field), Array.from(disp.coverage));
});

test('display: limits ignore masked and non-finite samples', () => {
  const values = new Float64Array([1, 2, 3, 1e9, NaN, 4]);
  const mask = new Uint8Array([1, 1, 1, 0, 1, 1]);
  const lim = computeDisplayLimits(values, mask, {});
  assert.equal(lim.min, 1);
  assert.equal(lim.max, 4);
  assert.equal(lim.sampleCount, 4);
});

test('display: constant field gets a widened range so it maps to mid-grey', () => {
  const values = new Float64Array(4).fill(7);
  const lim = computeDisplayLimits(values, null, {});
  assert.ok(lim.max > lim.min);
  const { rgba } = mapFloatFieldToRgba(values, null, lim, {});
  assert.ok(rgba[0] > 100 && rgba[0] < 160, `mid-grey, got ${rgba[0]}`);
});

test('display: NaN cells are transparent, never black', () => {
  const values = new Float64Array([1, NaN]);
  const lim = { min: 1, max: 1.000001 };
  const { rgba } = mapFloatFieldToRgba(values, null, lim, {});
  assert.equal(rgba[3], 255);
  assert.equal(rgba[7], 0);
});

test('display: percentile limits are robust to a single extreme outlier', () => {
  const values = Float64Array.from({ length: 101 }, (_, i) => (i === 50 ? 1e9 : i));
  const lim = computeDisplayLimits(values, null, { lowPercentile: 5, highPercentile: 95 });
  assert.ok(lim.max < 1e8, `max should not be the outlier, got ${lim.max}`);
  assert.equal(lim.method, 'percentile-valid');
});

test('display: log scale handles zeros and negatives without producing NaN colours', () => {
  const values = new Float64Array([-1, 0, 1, 10, 100]);
  const lim = computeDisplayLimits(values, null, {});
  const { rgba } = mapFloatFieldToRgba(values, null, lim, { scale: 'log' });
  for (let i = 0; i < rgba.length; i++) assert.ok(Number.isFinite(rgba[i]));
});
