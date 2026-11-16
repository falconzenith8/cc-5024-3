#!/usr/bin/env node
// Float sample validator CLI. All rules live in validate-float-samples.lib.js
// so the node test suite exercises the same code path.
//
// Usage: node tools/validate-float-samples.js DIR [DIR ...] [--json]

import { validateSampleDir } from './validate-float-samples.lib.js';

const jsonMode = process.argv.includes('--json');
const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (dirs.length === 0) {
  process.stderr.write('usage: node tools/validate-float-samples.js DIR [DIR ...] [--json]\n');
  process.exit(2);
}

const results = dirs.map(validateSampleDir);
if (jsonMode) {
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} else {
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.dir}\n`);
    const s = r.evidence.summary;
    if (s) {
      process.stdout.write(`  cells ${s.cells} · defined ${s.defined} · undefined(NaN) ${s.undefinedCells} · coverage amount ${s.totalOverlap}\n`);
    }
    for (const e of r.errors) process.stderr.write(`  ERROR: ${e}\n`);
  }
}
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  process.stderr.write(`\n${failed.length} sample director(y|ies) failed float validation\n`);
  process.exit(1);
}
process.stderr.write(`all ${results.length} sample director(y|ies) satisfy the float contract\n`);
