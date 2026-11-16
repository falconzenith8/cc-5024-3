#!/usr/bin/env node
// Auxiliary CLI for floating-point resampling. The graphical page is the
// primary entry point; this exists for scripting and reproducibility checks.

import fs from 'node:fs';
import path from 'node:path';
import { parseNpy } from '../core/npy.js';
import { resample } from '../core/resample.js';
import {
  resultToCsv,
  resultToJson,
  intensityNpy,
  coverageNpy,
  validWeightNpy,
} from '../core/output.js';

const USAGE = `Usage:
  node src/cli/resample.js --input values.npy [--mask mask.npy] --out DIR \\
      --width W --height H [--extent x0,y0,x1,y1] [--mode mean|sum] \\
      [--compensate] [--pixel-area N] [--low-coverage T] [--dtype float32|float64]

Notes:
  * --mode mean  : area-weighted mean, intensity units (default)
  * --mode sum   : sum of value*overlap, scaled by --pixel-area
  * --compensate : sum mode only, divides by coverage (estimate, not conserved)
  * Mask values: 0 = invalid, non-zero = valid. NaN/Inf values are always missing.
  * The GUI (npm start) is the intended primary entry point.
`;

function parseArgs(argv) {
  const args = {
    mode: 'mean',
    dtype: 'float64',
    compensate: false,
    pixelArea: 1,
    lowCoverage: 0.5,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--input': args.input = next(); break;
      case '--mask': args.mask = next(); break;
      case '--out': args.out = next(); break;
      case '--width': args.width = Number(next()); break;
      case '--height': args.height = Number(next()); break;
      case '--extent': args.extent = next().split(',').map(Number); break;
      case '--mode': args.mode = next(); break;
      case '--compensate': args.compensate = true; break;
      case '--pixel-area': args.pixelArea = Number(next()); break;
      case '--low-coverage': args.lowCoverage = Number(next()); break;
      case '--dtype': args.dtype = next(); break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    fail(e.message);
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!args.input || !args.out) fail('--input and --out are required');
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height)) {
    fail('--width and --height must be integers');
  }
  if (args.extent && (args.extent.length !== 4 || args.extent.some((v) => !Number.isFinite(v)))) {
    fail('--extent must be x0,y0,x1,y1');
  }
  if (args.mode !== 'mean' && args.mode !== 'sum') fail('--mode must be mean or sum');
  if (args.dtype !== 'float32' && args.dtype !== 'float64') fail('--dtype must be float32 or float64');

  let values;
  try {
    values = parseNpy(fs.readFileSync(args.input));
  } catch (e) {
    fail(`cannot read input: ${e.message}`);
  }
  let mask = null;
  if (args.mask) {
    let m;
    try {
      m = parseNpy(fs.readFileSync(args.mask));
    } catch (e) {
      fail(`cannot read mask: ${e.message}`);
    }
    if (m.width !== values.width || m.height !== values.height) {
      fail('mask dimensions must match the input array');
    }
    mask = new Uint8Array(m.data.length);
    for (let i = 0; i < m.data.length; i++) mask[i] = m.data[i] !== 0 ? 1 : 0;
  }

  let result;
  try {
    result = resample({
      values: values.data,
      mask,
      width: values.width,
      height: values.height,
      grid: { width: args.width, height: args.height, extent: args.extent },
      mode: args.mode,
      compensate: args.compensate,
      sourcePixelArea: args.pixelArea,
      lowCoverageThreshold: args.lowCoverage,
    });
  } catch (e) {
    fail(e.message);
  }

  fs.mkdirSync(args.out, { recursive: true });
  const written = [];
  const write = (name, bytes) => {
    const p = path.join(args.out, name);
    fs.writeFileSync(p, bytes);
    written.push(p);
  };
  write('intensity.npy', intensityNpy(result, args.dtype));
  write('coverage.npy', coverageNpy(result, args.dtype));
  write('valid_weight.npy', validWeightNpy(result, args.dtype));
  write('cells.csv', resultToCsv(result));
  write(
    'meta.json',
    resultToJson(result, {
      inputs: {
        values: path.basename(args.input),
        mask: args.mask ? path.basename(args.mask) : null,
      },
    }),
  );

  process.stdout.write(`wrote:\n  ${written.join('\n  ')}\n`);
  process.stdout.write(
    `\nsemantics: ${result.quantity} (${result.quantityUnits})\n` +
      `valid source pixels: ${result.stats.validPixels}/${result.stats.sourcePixels}\n` +
      `undefined output cells: ${result.stats.undefinedCells}\n` +
      `integral conserved: ${result.stats.integralConserved}\n`,
  );
  for (const a of result.anomalies) {
    process.stdout.write(`[${a.severity}] ${a.code}: ${a.message}\n`);
  }
}

main();
