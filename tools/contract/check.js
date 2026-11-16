#!/usr/bin/env node
// Validity-contract maintenance entry point. Runs the shared scenarios through
// the production resampling kernel (the same entry used by the graphical page
// and the CLI), checks every invariant from tools/contract/run-checks.js, and
// prints the coverage amount and the valid mean as execution evidence.
//
// Exit code is non-zero on the first violated invariant. There is no default
// fill path: an unexpected zero where the contract requires NaN fails here.
//
// Usage: node tools/contract/check.js [--json]

import { runChecks } from './run-checks.js';

const jsonMode = process.argv.includes('--json');
const reports = runChecks();

if (jsonMode) {
  process.stdout.write(JSON.stringify(reports.map((r) => ({
    id: r.id,
    ok: r.ok,
    failures: r.failures,
    evidence: r.evidence,
  })), null, 2) + '\n');
} else {
  for (const r of reports) {
    process.stdout.write(`\n${r.ok ? 'PASS' : 'FAIL'}  ${r.id} — ${r.title}\n`);
    const e = r.evidence[0];
    process.stdout.write(
      `  valid source pixels : ${e.validPixels}/${e.sourcePixels}\n` +
      `  coverage amount     : total overlap ${formatNum(e.totalOverlapArea)}, ` +
      `source coverage ${formatNum(e.sourceCoverage)}\n` +
      `  undefined cells     : ${e.undefinedCells} (NaN, never 0)\n` +
      `  source valid mean   : ${formatNum(e.sourceMean)}\n` +
      `  output valid mean   : ${formatNum(e.outputMean)}\n` +
      `  anomalies           : ${e.anomalies.join(', ') || '(none)'}\n`);
    for (const c of e.cells) {
      process.stdout.write(
        `  cell (${c.x},${c.y}): intensity=${c.defined ? formatNum(c.intensity) : 'NaN'} ` +
        `coverage=${c.coverage.toFixed(3)} validWeight=${formatNum(c.validWeight)}\n`);
    }
    for (const f of r.failures) process.stderr.write(`  VIOLATION: ${f}\n`);
  }
}

const failed = reports.filter((r) => !r.ok);
if (failed.length) {
  process.stderr.write(`\n${failed.length} contract scenario(s) violated\n`);
  process.exit(1);
}
process.stderr.write(`\nall ${reports.length} validity-contract scenarios hold\n`);

function formatNum(v) {
  if (v === null) return 'null';
  if (Number.isNaN(v)) return 'NaN';
  if (typeof v !== 'number') return String(v);
  return Number(v.toPrecision(17)).toString();
}
