// Validity contract scenarios.
//
// One source of truth shared by:
//   * tools/contract/generate.js — emits the runnable examples (SVG + tables)
//   * tools/contract/check.js    — re-runs the engine and checks the contract
//
// Every scenario stores explicit, independently computable expectations. The
// numbers are derived from the unit-square overlap model with integer or
// half-integer splits, so they can be checked by hand. Nothing here imports
// the production resampler; the checker recomputes expectations itself.
//
// Contract invariants (never weakened):
//   1. A no-data cell (no usable overlap) is NaN, never a substituted zero.
//   2. A real 0.0 inside the mask is a valid measurement with full weight.
//   3. NaN/Inf inside the mask carry zero weight and are flagged as missing.
//   4. Coverage is the usable-overlap fraction of the cell footprint.
//   5. The valid mean is weighted by usable overlap only; excluded samples
//      cannot dilute it.

function arr(values) {
  return Float64Array.from(values);
}

function mask(values) {
  return Uint8Array.from(values);
}

export const CONTRACT_SCENARIOS = [
  {
    id: 'partial-missing',
    title: 'Local missing data: true zero, hole, masked non-zero and NaN in one row',
    width: 4,
    height: 1,
    // pixel:       0      1        2      3
    // state:    true 0  masked   NaN-in  valid
    values: arr([0, 55, NaN, 40]),
    mask: mask([1, 0, 1, 1]),
    grid: { width: 2, height: 1 },
    mode: 'mean',
    // Coverage 0.5 cells must be reported as low coverage at this threshold.
    lowCoverageThreshold: 0.6,
    // Cell 0 = pixels [0,2): pixel 0 usable (true zero, weight 1),
    //          pixel 1 masked (weight 0). Cell 1 = pixels [2,4):
    //          pixel 2 NaN (weight 0), pixel 3 usable (weight 1).
    expected: {
      validPixels: 2, // pixel 0 (zero) and pixel 3; NaN and masked excluded
      sourcePixels: 4,
      validTrueZeros: 1,
      maskedNonFinite: 1,
      excludedNonZero: 1,
      cells: [
        { x: 0, y: 0, defined: true, coverage: 0.5, validWeight: 1, intensity: 0 },
        { x: 1, y: 0, defined: true, coverage: 0.5, validWeight: 1, intensity: 40 },
      ],
      anomalies: ['NONFINITE_MARKED_VALID', 'NONZERO_MASKED_OUT', 'LOW_COVERAGE'],
      anomalyForbidden: ['UNDEFINED_OUTPUT_CELLS', 'NO_VALID_SAMPLES'],
    },
  },
  {
    id: 'sparse-valid-region',
    title: 'Sparse valid region: one usable cell next to an entirely empty cell',
    width: 4,
    height: 1,
    // Only pixel 2 carries a usable finite value.
    values: arr([7, 7, 9, 7]),
    mask: mask([0, 0, 1, 0]),
    grid: { width: 2, height: 1 },
    mode: 'mean',
    // Cell 0 = pixels [0,2): both masked -> no usable overlap -> NaN.
    // Cell 1 = pixels [2,4): only pixel 2 usable (weight 1) -> mean 9.
    lowCoverageThreshold: 0.6,
    expected: {
      validPixels: 1,
      sourcePixels: 4,
      validTrueZeros: 0,
      maskedNonFinite: 0,
      excludedNonZero: 3,
      cells: [
        { x: 0, y: 0, defined: false, coverage: 0, validWeight: 0, intensity: NaN },
        { x: 1, y: 0, defined: true, coverage: 0.5, validWeight: 1, intensity: 9 },
      ],
      anomalies: ['NONZERO_MASKED_OUT', 'UNDEFINED_OUTPUT_CELLS', 'LOW_COVERAGE'],
      anomalyForbidden: ['NO_VALID_SAMPLES'],
    },
  },
  {
    id: 'all-missing',
    title: 'All missing: every output cell is NaN with coverage 0, never zero',
    width: 4,
    height: 1,
    // Half masked, half NaN inside the mask: two different no-data routes,
    // neither of which may be interpreted as a numeric zero.
    values: arr([1, 2, NaN, NaN]),
    mask: mask([0, 0, 1, 1]),
    grid: { width: 2, height: 1 },
    mode: 'mean',
    expected: {
      validPixels: 0,
      sourcePixels: 4,
      validTrueZeros: 0,
      maskedNonFinite: 2,
      excludedNonZero: 2,
      cells: [
        { x: 0, y: 0, defined: false, coverage: 0, validWeight: 0, intensity: NaN },
        { x: 1, y: 0, defined: false, coverage: 0, validWeight: 0, intensity: NaN },
      ],
      anomalies: ['NO_VALID_SAMPLES', 'NONFINITE_MARKED_VALID', 'UNDEFINED_OUTPUT_CELLS'],
      anomalyForbidden: [],
      // stats values that must be reported as NaN/null rather than 0 defaults.
      sourceMeanNaN: true,
      outputMeanNaN: true,
      validMinNull: true,
      validMaxNull: true,
    },
  },
];

/**
 * Independent expectation recomputation, written directly from the unit-square
 * overlap model. Deliberately does not call resample(): this is the second
 * implementation used to prove the production one honours the contract.
 */
export function expectedCellOverlaps(scenario) {
  const { width, height, values, mask: m, grid } = scenario;
  const [x0, y0, x1, y1] = grid.extent ?? [0, 0, width, height];
  const stepX = (x1 - x0) / grid.width;
  const stepY = (y1 - y0) / grid.height;
  const footprint = stepX * stepY;
  const cells = [];
  for (let oy = 0; oy < grid.height; oy++) {
    for (let ox = 0; ox < grid.width; ox++) {
      const cx0 = x0 + ox * stepX;
      const cx1 = cx0 + stepX;
      const cy0 = y0 + oy * stepY;
      const cy1 = cy0 + stepY;
      let weight = 0;
      let weightedValue = 0;
      for (let iy = 0; iy < height; iy++) {
        const oyOverlap = Math.min(cy1, iy + 1) - Math.max(cy0, iy);
        if (!(oyOverlap > 0)) continue;
        for (let ix = 0; ix < width; ix++) {
          const oxOverlap = Math.min(cx1, ix + 1) - Math.max(cx0, ix);
          if (!(oxOverlap > 0)) continue;
          const p = iy * width + ix;
          const usable = m[p] !== 0 && Number.isFinite(values[p]);
          if (!usable) continue;
          const w = oxOverlap * oyOverlap;
          weight += w;
          weightedValue += w * values[p];
        }
      }
      cells.push({
        x: ox,
        y: oy,
        validWeight: weight,
        coverage: Math.min(1, weight / footprint),
        intensity: weight > 0 ? weightedValue / weight : NaN,
      });
    }
  }
  return cells;
}
