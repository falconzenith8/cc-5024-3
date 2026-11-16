// Pure validity-contract checks. No filesystem access and no process exit:
// tools/contract/check.js and test/contract.test.js both call runChecks().
//
// Each check compares the production engine against the independently derived
// expectations in scenarios.js and also verifies the cross-quantity
// relationships that the documentation promises (coverage amount and the
// valid mean). A failure names the exact invariant that was violated.

import { resample } from '../../src/core/resample.js';
import { CONTRACT_SCENARIOS, expectedCellOverlaps } from './scenarios.js';

const TOL = 1e-12;

function close(a, b, tol = TOL) {
  return Math.abs(a - b) <= tol;
}

function checkOne(scenario) {
  const { values, mask, width, height, grid, mode, expected } = scenario;
  const failures = [];
  const evidence = [];
  const fail = (msg) => failures.push(msg);

  const result = resample({
    values, mask, width, height, grid, mode,
    lowCoverageThreshold: scenario.lowCoverageThreshold ?? 0.5,
  });

  // ---- source-level counters -------------------------------------------
  const counters = [
    ['validPixels', result.stats.validPixels, expected.validPixels],
    ['sourcePixels', result.stats.sourcePixels, expected.sourcePixels],
    ['validTrueZeros', result.stats.validTrueZeros, expected.validTrueZeros],
    ['maskedNonFinite', result.stats.maskedNonFinite, expected.maskedNonFinite],
    ['excludedNonZero', result.stats.excludedNonZero, expected.excludedNonZero],
  ];
  for (const [name, got, want] of counters) {
    if (got !== want) fail(`stats.${name}: got ${got}, expected ${want}`);
  }

  // ---- anomaly codes ----------------------------------------------------
  const codes = new Set(result.anomalies.map((a) => a.code));
  for (const code of expected.anomalies) {
    if (!codes.has(code)) fail(`expected anomaly ${code} was not raised`);
  }
  for (const code of expected.anomalyForbidden ?? []) {
    if (codes.has(code)) fail(`forbidden anomaly ${code} was raised`);
  }

  // ---- no-data must never be defaulted to zero --------------------------
  if (expected.sourceMeanNaN && !Number.isNaN(result.stats.sourceMean)) {
    fail('stats.sourceMean must be NaN when no usable samples exist');
  }
  if (expected.outputMeanNaN && !Number.isNaN(result.stats.outputMean)) {
    fail('stats.outputMean must be NaN when no usable overlap exists');
  }
  if (expected.validMinNull && result.stats.validMin !== null) {
    fail('stats.validMin must be null, not a zero default');
  }
  if (expected.validMaxNull && result.stats.validMax !== null) {
    fail('stats.validMax must be null, not a zero default');
  }

  // ---- per-cell contract and independent overlap recomputation ----------
  const independent = expectedCellOverlaps(scenario);
  for (const want of expected.cells) {
    const i = want.y * grid.width + want.x;
    const gotDefined = result.defined[i] === 1;
    if (gotDefined !== want.defined) {
      fail(`cell (${want.x},${want.y}) defined: got ${gotDefined}, expected ${want.defined}`);
    }
    if (want.defined) {
      if (!close(result.coverage[i], want.coverage)) {
        fail(`cell (${want.x},${want.y}) coverage: got ${result.coverage[i]}, expected ${want.coverage}`);
      }
      if (!close(result.validWeight[i], want.validWeight)) {
        fail(`cell (${want.x},${want.y}) validWeight: got ${result.validWeight[i]}, expected ${want.validWeight}`);
      }
      if (Number.isNaN(result.intensity[i])) {
        fail(`cell (${want.x},${want.y}) must be a finite value, got NaN`);
      } else if (!close(result.intensity[i], want.intensity)) {
        fail(`cell (${want.x},${want.y}) intensity: got ${result.intensity[i]}, expected ${want.intensity}`);
      }
      // The valid mean must equal overlapSum / validWeight exactly; this
      // proves the reported mean is the coverage-weighted mean of usable
      // samples and nothing else.
      const recomputedMean = result.overlapSum[i] / result.validWeight[i];
      if (!close(recomputedMean, result.intensity[i], 1e-10)) {
        fail(`cell (${want.x},${want.y}) mean != overlapSum/validWeight`);
      }
    } else {
      // The central rule: no usable data => NaN, coverage 0, weight 0.
      if (!Number.isNaN(result.intensity[i])) {
        fail(`cell (${want.x},${want.y}) must be NaN (no usable overlap), got ${result.intensity[i]}`);
      }
      if (result.coverage[i] !== 0 || result.validWeight[i] !== 0) {
        fail(`cell (${want.x},${want.y}) empty cell must have coverage/weight 0`);
      }
      if (result.overlapSum[i] !== 0) {
        fail(`cell (${want.x},${want.y}) empty cell overlapSum must be 0`);
      }
    }
    // Independent implementation agreement (both coverage and mean).
    const ref = independent[i];
    if (Number.isNaN(ref.intensity)) {
      if (!Number.isNaN(result.intensity[i])) {
        fail(`cell (${want.x},${want.y}) independent reference expects NaN`);
      }
    } else if (!close(ref.intensity, result.intensity[i], 1e-10)) {
      fail(`cell (${want.x},${want.y}) disagrees with independent reference mean`);
    }
    if (!close(ref.coverage, result.coverage[i])) {
      fail(`cell (${want.x},${want.y}) disagrees with independent reference coverage`);
    }
    if (!close(ref.validWeight, result.validWeight[i])) {
      fail(`cell (${want.x},${want.y}) disagrees with independent reference weight`);
    }
  }

  // ---- aggregate coverage amount matches the sum of per-cell weights ----
  const weightTotal = result.validWeight.reduce((a, b) => a + b, 0);
  if (!close(weightTotal, result.stats.totalOverlapArea)) {
    fail('sum(validWeight) != stats.totalOverlapArea');
  }
  // No cell's coverage may exceed 1 or fall below 0.
  for (let i = 0; i < result.coverage.length; i++) {
    const c = result.coverage[i];
    if (!(c >= 0 && c <= 1)) fail(`coverage out of [0,1] at cell ${i}: ${c}`);
  }

  evidence.push({
    scenario: scenario.id,
    validPixels: result.stats.validPixels,
    sourcePixels: result.stats.sourcePixels,
    validTrueZeros: result.stats.validTrueZeros,
    maskedNonFinite: result.stats.maskedNonFinite,
    excludedNonZero: result.stats.excludedNonZero,
    totalOverlapArea: result.stats.totalOverlapArea,
    sourceCoverage: result.stats.sourceCoverage,
    undefinedCells: result.stats.undefinedCells,
    sourceMean: result.stats.sourceMean,
    outputMean: result.stats.outputMean,
    cells: expected.cells.map((want) => {
      const i = want.y * grid.width + want.x;
      return {
        x: want.x,
        y: want.y,
        intensity: result.intensity[i],
        coverage: result.coverage[i],
        validWeight: result.validWeight[i],
        overlapSum: result.overlapSum[i],
        defined: result.defined[i] === 1,
      };
    }),
    anomalies: [...codes],
  });

  return { id: scenario.id, title: scenario.title, ok: failures.length === 0, failures, evidence, result };
}

export function runChecks() {
  return CONTRACT_SCENARIOS.map(checkOne);
}
