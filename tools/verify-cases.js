#!/usr/bin/env node
// Recomputes every case in cases/ with the production engine, compares it to
// the independent reference implementation, and prints a reference-error
// report. Exits non-zero if any numeric tolerance is exceeded.
//
// Usage: node tools/verify-cases.js [--json]

import fs from 'node:fs';
import path from 'node:path';
import { parseNpy, writeNpy } from '../src/core/npy.js';
import { resample, describeResult } from '../src/core/resample.js';
import { referenceResampleExact, maxAbsDiff, maxRelDiff } from '../src/core/reference.js';
import { resultToCsv, resultToJson } from '../src/core/output.js';

const ROOT = process.cwd();
const CASES = path.join(ROOT, 'cases');
const OUT = path.join(ROOT, 'cases', '_results');
const jsonMode = process.argv.includes('--json');

const report = [];

const caseDirs = fs
  .readdirSync(CASES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .map((d) => d.name)
  .sort();

for (const name of caseDirs) {
  const dir = path.join(CASES, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  const values = parseNpy(fs.readFileSync(path.join(dir, 'values.npy')));
  let mask = null;
  if (fs.existsSync(path.join(dir, 'mask.npy'))) {
    const m = parseNpy(fs.readFileSync(path.join(dir, 'mask.npy')));
    mask = new Uint8Array(m.data.length);
    for (let i = 0; i < m.data.length; i++) mask[i] = m.data[i] !== 0 ? 1 : 0;
  }
  const grid = meta.gridSuggestion;
  const mode = meta.semanticsSuggestion || 'mean';

  const got = resample({
    values: values.data,
    mask,
    width: values.width,
    height: values.height,
    grid,
    mode,
  });
  const ref = referenceResampleExact({
    values: values.data,
    mask,
    width: values.width,
    height: values.height,
    outWidth: grid.width,
    outHeight: grid.height,
    mode,
  });

  const absIntensity = maxAbsDiff(got.intensity, ref.intensity);
  const relIntensity = maxRelDiff(got.intensity, ref.intensity, 1e-9);
  const absCoverage = maxAbsDiff(got.coverage, ref.coverage);

  const entry = {
    case: name,
    mode,
    grid: `${grid.width}x${grid.height}`,
    input: `${values.width}x${values.height}${mask ? ' + mask' : ''}`,
    maxAbsErrorIntensity: absIntensity,
    maxRelErrorIntensity: relIntensity,
    maxAbsErrorCoverage: absCoverage,
    validSourcePixels: got.stats.validPixels,
    sourcePixels: got.stats.sourcePixels,
    undefinedOutputCells: got.stats.undefinedCells,
    integralConserved: got.stats.integralConserved,
    anomalies: got.anomalies.map((a) => a.code),
    tolerance: { intensity: 'relative < 1e-12', coverage: 'absolute < 1e-12' },
  };

  // Case-specific assertions from the fixture metadata.
  let caseOk = true;
  const checks = [];
  const exp = meta.expected || {};
  if (exp.allValidCellsIntensity !== undefined) {
    let worst = 0;
    for (let i = 0; i < got.intensity.length; i++) {
      if (got.defined[i]) worst = Math.max(worst, Math.abs(got.intensity[i] - exp.allValidCellsIntensity));
    }
    const ok = worst < 1e-12;
    checks.push({ check: 'constant intensity', ok, detail: `max deviation ${worst}` });
    caseOk &&= ok;
  }
  if (exp.allValidCellsCoverage !== undefined) {
    let worst = 0;
    for (let i = 0; i < got.coverage.length; i++) {
      if (got.defined[i]) worst = Math.max(worst, Math.abs(got.coverage[i] - exp.allValidCellsCoverage));
    }
    const ok = worst < 1e-12;
    checks.push({ check: 'constant coverage', ok, detail: `max deviation ${worst}` });
    caseOk &&= ok;
  }
  if (exp.discreteTotal !== undefined) {
    const rel = Math.abs(got.stats.outputIntegral - exp.discreteTotal) / exp.discreteTotal;
    const ok = rel <= (exp.toleranceRelative ?? 1e-12);
    checks.push({ check: 'discrete integral', ok, detail: `relative error ${rel}` });
    caseOk &&= ok;
  }
  if (exp.cell0Intensity !== undefined) {
    const v = got.intensity[0];
    const ok = Number.isNaN(exp.cell0Intensity) ? Number.isNaN(v) : Math.abs(v - exp.cell0Intensity) < 1e-12;
    checks.push({ check: 'cell0 intensity', ok, detail: `${v}` });
    caseOk &&= ok;
  }
  if (exp.cell0Coverage !== undefined) {
    const ok = Math.abs(got.coverage[0] - exp.cell0Coverage) < 1e-12;
    checks.push({ check: 'cell0 coverage', ok, detail: `${got.coverage[0]}` });
    caseOk &&= ok;
  }
  if (exp.cell1Intensity !== undefined) {
    const v = got.intensity[1];
    const ok = Number.isNaN(exp.cell1Intensity) ? Number.isNaN(v) : Math.abs(v - exp.cell1Intensity) < 1e-12;
    checks.push({ check: 'cell1 intensity', ok, detail: `${v}` });
    caseOk &&= ok;
  }
  // Intensity spans many orders of magnitude across cases, so judge it by
  // relative error (with a small absolute floor); coverage is bounded 0..1.
  const numericOk = relIntensity < 1e-12 && absCoverage < 1e-12;
  if (!numericOk) caseOk = false;
  entry.checks = checks;
  entry.ok = caseOk && numericOk;

  // Write per-case deliverables so the case is independently recomputable.
  const outDir = path.join(OUT, name);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'intensity.npy'), writeNpy(got.intensity, got.width, got.height));
  fs.writeFileSync(path.join(outDir, 'coverage.npy'), writeNpy(got.coverage, got.width, got.height));
  fs.writeFileSync(path.join(outDir, 'cells.csv'), resultToCsv(got));
  fs.writeFileSync(
    path.join(outDir, 'meta.json'),
    resultToJson(got, {
      recompute: {
        command: `node src/cli/resample.js --input cases/${name}/values.npy` +
          (mask ? ` --mask cases/${name}/mask.npy` : '') +
          ` --out out/${name} --width ${grid.width} --height ${grid.height} --mode ${mode}`,
        reference: 'src/core/reference.js (scatter overlap)',
      },
    }),
  );

  report.push(entry);
}

if (jsonMode) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const header = ['case', 'mode', 'grid', 'maxAbsErr', 'maxRelErr', 'covErr', 'undefined', 'conserved', 'ok'];
  const rows = report.map((r) => [
    r.case,
    r.mode,
    r.grid,
    r.maxAbsErrorIntensity.toExponential(3),
    r.maxRelErrorIntensity.toExponential(3),
    r.maxAbsErrorCoverage.toExponential(3),
    String(r.undefinedOutputCells),
    String(r.integralConserved),
    r.ok ? 'PASS' : 'FAIL',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ');
  process.stdout.write(fmt(header) + '\n');
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
  for (const r of rows) process.stdout.write(fmt(r) + '\n');
  for (const r of report) {
    for (const c of r.checks || []) {
      if (!c.ok) process.stdout.write(`  ${r.case}: ${c.check} FAILED (${c.detail})\n`);
    }
  }
}

const failed = report.filter((r) => !r.ok);
if (failed.length > 0) {
  process.stderr.write(`${failed.length} case(s) failed reference comparison\n`);
  process.exit(1);
}
process.stderr.write(`all ${report.length} cases match the independent reference\n`);
