// Pure float-sample validation logic, shared by the CLI
// (tools/validate-float-samples.js) and the node test suite. No process
// access and no defaults: anything absent or inconsistent is an error.

import fs from 'node:fs';
import path from 'node:path';
import { parseNpy } from '../src/core/npy.js';

export function parseCellsCsv(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const idx = (name) => header.indexOf(name);
  const iX = idx('x');
  const iY = idx('y');
  const iIntensity = idx('intensity');
  const iCoverage = idx('coverage');
  const iWeight = idx('valid_weight');
  const iDefined = idx('defined');
  for (const [name, i] of [['x', iX], ['y', iY], ['intensity', iIntensity],
    ['coverage', iCoverage], ['valid_weight', iWeight], ['defined', iDefined]]) {
    if (i < 0) throw new Error(`cells.csv is missing the ${name} column`);
  }
  return lines.slice(1).map((line) => {
    const c = line.split(',');
    return {
      x: Number(c[iX]),
      y: Number(c[iY]),
      intensity: c[iIntensity] === 'nan' ? NaN : Number(c[iIntensity]),
      coverage: Number(c[iCoverage]),
      validWeight: Number(c[iWeight]),
      defined: Number(c[iDefined]) === 1,
    };
  });
}

export function validateSampleDir(dir) {
  const errors = [];
  const evidence = { dir, files: {} };
  const required = ['intensity.npy', 'coverage.npy', 'valid_weight.npy', 'cells.csv', 'meta.json'];
  for (const name of required) {
    if (!fs.existsSync(path.join(dir, name))) {
      errors.push(`missing required artifact ${name} (no default is substituted)`);
    }
  }
  if (errors.length) return { dir, ok: false, errors, evidence };

  const requireRead = (name, fn) => {
    try {
      return fn(fs.readFileSync(path.join(dir, name)));
    } catch (e) {
      errors.push(`${name} unreadable: ${e.message}`);
      return null;
    }
  };

  const intensityNpy = requireRead('intensity.npy', (b) => parseNpy(b));
  const coverageNpy = requireRead('coverage.npy', (b) => parseNpy(b));
  const weightNpy = requireRead('valid_weight.npy', (b) => parseNpy(b));
  const rows = requireRead('cells.csv', (b) => parseCellsCsv(b.toString('utf8')));
  const meta = requireRead('meta.json', (b) => JSON.parse(b.toString('utf8')));
  if (errors.length) return { dir, ok: false, errors, evidence };

  evidence.files = {
    intensity: { width: intensityNpy.width, height: intensityNpy.height, dtype: intensityNpy.dtype },
    coverage: { width: coverageNpy.width, height: coverageNpy.height, dtype: coverageNpy.dtype },
    validWeight: { width: weightNpy.width, height: weightNpy.height, dtype: weightNpy.dtype },
    csvRows: rows.length,
  };

  const n = intensityNpy.data.length;
  if (coverageNpy.data.length !== n || weightNpy.data.length !== n) {
    errors.push('intensity/coverage/valid_weight grid shapes differ');
  }
  if (rows.length !== n) {
    errors.push(`cells.csv has ${rows.length} rows but intensity.npy has ${n} cells`);
  }
  if (coverageNpy.width !== intensityNpy.width || coverageNpy.height !== intensityNpy.height) {
    errors.push('coverage.npy grid dimensions differ from intensity.npy');
  }

  let undefinedCells = 0;
  let totalOverlap = 0;
  let definedCount = 0;
  for (let i = 0; i < n; i++) {
    const v = intensityNpy.data[i];
    const c = coverageNpy.data[i];
    const w = weightNpy.data[i];
    if (!(c >= 0 && c <= 1)) errors.push(`cell ${i}: coverage ${c} outside [0,1]`);
    if (!(w >= 0)) errors.push(`cell ${i}: valid_weight ${w} is negative`);
    if (Number.isNaN(v)) {
      undefinedCells++;
      // The contract: no data => NaN plus exactly zero coverage and weight.
      if (c !== 0) errors.push(`cell ${i}: NaN intensity must pair with coverage 0, got ${c}`);
      if (w !== 0) errors.push(`cell ${i}: NaN intensity must pair with valid_weight 0, got ${w}`);
    } else {
      definedCount++;
      if (!Number.isFinite(v)) errors.push(`cell ${i}: defined intensity must be finite, got ${v}`);
      if (w === 0) errors.push(`cell ${i}: finite intensity ${v} has zero valid weight`);
    }
    totalOverlap += w;
  }

  // Cross-check every CSV row against the NPY arrays at full precision. The
  // table quoted in documentation must be the same numbers as the float data.
  for (const row of rows) {
    const i = row.y * intensityNpy.width + row.x;
    if (i < 0 || i >= n) {
      errors.push(`cells.csv cell (${row.x},${row.y}) outside grid`);
      continue;
    }
    const v = intensityNpy.data[i];
    if (row.defined) {
      if (Number.isNaN(v) || v !== row.intensity) {
        errors.push(`cell (${row.x},${row.y}): CSV intensity ${row.intensity} != NPY ${v}`);
      }
    } else if (!Number.isNaN(v)) {
      errors.push(`cell (${row.x},${row.y}): CSV says undefined but NPY holds ${v} (zero fill?)`);
    }
    if (row.coverage !== coverageNpy.data[i]) {
      errors.push(`cell (${row.x},${row.y}): CSV coverage ${row.coverage} != NPY ${coverageNpy.data[i]}`);
    }
    if (row.validWeight !== weightNpy.data[i]) {
      errors.push(`cell (${row.x},${row.y}): CSV valid_weight ${row.validWeight} != NPY ${weightNpy.data[i]}`);
    }
  }

  if (meta.stats) {
    if (meta.stats.undefinedCells !== undefinedCells) {
      errors.push(`meta.stats.undefinedCells=${meta.stats.undefinedCells} but arrays show ${undefinedCells}`);
    }
    if (typeof meta.stats.totalOverlapArea === 'number' &&
        Math.abs(meta.stats.totalOverlapArea - totalOverlap) > 1e-9) {
      errors.push(`meta.stats.totalOverlapArea=${meta.stats.totalOverlapArea} but weights sum to ${totalOverlap}`);
    }
    if (meta.stats.outputCells !== n) {
      errors.push(`meta.stats.outputCells=${meta.stats.outputCells} but arrays have ${n} cells`);
    }
  } else {
    errors.push('meta.json has no stats section');
  }

  evidence.summary = { cells: n, defined: definedCount, undefinedCells, totalOverlap };
  return { dir, ok: errors.length === 0, errors, evidence };
}
