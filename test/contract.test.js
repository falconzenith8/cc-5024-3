import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks } from '../tools/contract/run-checks.js';
import { CONTRACT_SCENARIOS, expectedCellOverlaps } from '../tools/contract/scenarios.js';
import { resample } from '../src/core/resample.js';
import { writeNpy } from '../src/core/npy.js';
import { resultToCsv, resultToJson } from '../src/core/output.js';
import { validateSampleDir } from '../tools/validate-float-samples.lib.js';

function runScenario(id) {
  const scenario = CONTRACT_SCENARIOS.find((s) => s.id === id);
  return resample({
    values: scenario.values,
    mask: scenario.mask,
    width: scenario.width,
    height: scenario.height,
    grid: scenario.grid,
    mode: scenario.mode,
  });
}

function writeSampleDir(result, mutate = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-validate-'));
  fs.writeFileSync(path.join(dir, 'intensity.npy'), writeNpy(result.intensity, result.width, result.height));
  fs.writeFileSync(path.join(dir, 'coverage.npy'), writeNpy(result.coverage, result.width, result.height));
  fs.writeFileSync(path.join(dir, 'valid_weight.npy'), writeNpy(result.validWeight, result.width, result.height));
  fs.writeFileSync(path.join(dir, 'cells.csv'), resultToCsv(result));
  fs.writeFileSync(path.join(dir, 'meta.json'), resultToJson(result));
  mutate(dir, result);
  return dir;
}

test('contract: every documented scenario holds against the production kernel', () => {
  const reports = runChecks();
  assert.equal(reports.length, CONTRACT_SCENARIOS.length);
  for (const r of reports) {
    assert.equal(r.ok, true, `${r.id}: ${r.failures.join('; ')}`);
  }
});

test('contract: sparse valid region has one NaN cell and one half-covered cell', () => {
  const report = runChecks().find((r) => r.id === 'sparse-valid-region');
  const ev = report.evidence[0];
  const cells = ev.cells;
  assert.equal(cells[0].defined, false);
  assert.ok(Number.isNaN(cells[0].intensity));
  assert.equal(cells[0].coverage, 0);
  assert.equal(cells[1].defined, true);
  assert.equal(cells[1].intensity, 9);
  assert.equal(cells[1].coverage, 0.5);
  assert.equal(ev.validPixels, 1);
  assert.ok(ev.anomalies.includes('UNDEFINED_OUTPUT_CELLS'));
});

test('contract: all-missing run reports NaN everywhere, never zero', () => {
  const report = runChecks().find((r) => r.id === 'all-missing');
  const ev = report.evidence[0];
  for (const c of ev.cells) {
    assert.equal(c.defined, false);
    assert.ok(Number.isNaN(c.intensity));
    assert.equal(c.coverage, 0);
    assert.equal(c.validWeight, 0);
  }
  assert.ok(Number.isNaN(ev.sourceMean));
  assert.ok(Number.isNaN(ev.outputMean));
  assert.ok(ev.anomalies.includes('NO_VALID_SAMPLES'));
  assert.equal(ev.undefinedCells, ev.cells.length);
});

test('contract: true zero stays a valid measurement at partial coverage', () => {
  const report = runChecks().find((r) => r.id === 'partial-missing');
  const ev = report.evidence[0];
  const [c0, c1] = ev.cells;
  assert.equal(c0.intensity, 0);
  assert.equal(c0.defined, true);
  assert.equal(c0.coverage, 0.5);
  assert.equal(c1.intensity, 40);
  assert.equal(ev.validTrueZeros, 1);
});

test('contract: independent expectation tables match the engine on every scenario', () => {
  for (const scenario of CONTRACT_SCENARIOS) {
    const result = resample({
      values: scenario.values,
      mask: scenario.mask,
      width: scenario.width,
      height: scenario.height,
      grid: scenario.grid,
      mode: scenario.mode,
    });
    const expected = expectedCellOverlaps(scenario);
    for (let i = 0; i < expected.length; i++) {
      if (Number.isNaN(expected[i].intensity)) {
        assert.ok(Number.isNaN(result.intensity[i]), `${scenario.id} cell ${i}`);
      } else {
        assert.ok(Math.abs(expected[i].intensity - result.intensity[i]) < 1e-10, scenario.id);
      }
      assert.ok(Math.abs(expected[i].coverage - result.coverage[i]) < 1e-12, scenario.id);
      assert.ok(Math.abs(expected[i].validWeight - result.validWeight[i]) < 1e-12, scenario.id);
    }
  }
});

test('validator: a genuine kernel output directory passes', () => {
  const dir = writeSampleDir(runScenario('sparse-valid-region'));
  const r = validateSampleDir(dir);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.evidence.summary.undefinedCells, 1);
});

test('validator: zero-filling a NaN cell is rejected rather than accepted as a default', () => {
  const dir = writeSampleDir(runScenario('sparse-valid-region'), (d, result) => {
    const broken = new Float64Array(result.intensity);
    broken[0] = 0; // the forbidden "no data means zero" mistake
    fs.writeFileSync(path.join(d, 'intensity.npy'), writeNpy(broken, result.width, result.height));
  });
  const r = validateSampleDir(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /zero fill|NaN intensity must pair/.test(e)));
});

test('validator: a missing artifact is a hard error, not a defaulted pass', () => {
  const dir = writeSampleDir(runScenario('sparse-valid-region'));
  fs.unlinkSync(path.join(dir, 'coverage.npy'));
  const r = validateSampleDir(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /missing required artifact coverage\.npy/.test(e)));
});

test('validator: CSV/NPY disagreement and wrong meta counters fail', () => {
  const dir = writeSampleDir(runScenario('sparse-valid-region'), (d, result) => {
    const wrongCov = new Float64Array(result.coverage);
    wrongCov[1] = 0.125;
    fs.writeFileSync(path.join(d, 'coverage.npy'), writeNpy(wrongCov, result.width, result.height));
    const wrongMeta = JSON.parse(resultToJson(result));
    wrongMeta.stats.undefinedCells = 0;
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(wrongMeta, null, 2));
  });
  const r = validateSampleDir(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /CSV coverage/.test(e)));
  assert.ok(r.errors.some((e) => /undefinedCells/.test(e)));
});

test('validator: all-missing sample passes only while every cell stays NaN', () => {
  const dir = writeSampleDir(runScenario('all-missing'));
  const r = validateSampleDir(dir);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.evidence.summary.defined, 0);
  assert.equal(r.evidence.summary.undefinedCells, 2);
});
