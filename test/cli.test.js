import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseNpy, writeNpy } from '../src/core/npy.js';
import { parseTiff } from '../src/core/tiff.js';

const CLI = path.join(process.cwd(), 'src/cli/resample.js');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-cli-'));
}

test('cli: mean mode writes float64 npy, coverage, csv and meta', () => {
  const dir = tempDir();
  const values = new Float64Array(16 * 16).fill(12.5);
  fs.writeFileSync(path.join(dir, 'values.npy'), writeNpy(values, 16, 16));
  const out = path.join(dir, 'out');
  const r = run(['--input', path.join(dir, 'values.npy'), '--out', out,
    '--width', '7', '--height', '5', '--mode', 'mean']);
  assert.equal(r.status, 0, r.stderr);
  const intensity = parseNpy(fs.readFileSync(path.join(out, 'intensity.npy')));
  assert.equal(intensity.width, 7);
  assert.equal(intensity.height, 5);
  for (const v of intensity.data) assert.ok(Math.abs(v - 12.5) < 1e-12);
  const cov = parseNpy(fs.readFileSync(path.join(out, 'coverage.npy')));
  for (const v of cov.data) assert.ok(Math.abs(v - 1) < 1e-12);
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  assert.equal(meta.semantics.mode, 'mean');
  assert.equal(meta.stats.integralConserved, false);
  const csv = fs.readFileSync(path.join(out, 'cells.csv'), 'utf8');
  assert.match(csv.split('\n')[0], /intensity/);
});

test('cli: mask file is applied and excluded pixels never enter the mean', () => {
  const dir = tempDir();
  const values = new Float64Array([100, 0, 0, 0]);
  fs.writeFileSync(path.join(dir, 'v.npy'), writeNpy(values, 2, 2));
  fs.writeFileSync(path.join(dir, 'm.npy'), writeNpy(new Float64Array([1, 0, 0, 0]), 2, 2));
  const out = path.join(dir, 'out');
  const r = run(['--input', path.join(dir, 'v.npy'), '--mask', path.join(dir, 'm.npy'),
    '--out', out, '--width', '1', '--height', '1']);
  assert.equal(r.status, 0, r.stderr);
  const npy = parseNpy(fs.readFileSync(path.join(out, 'intensity.npy')));
  assert.equal(npy.data[0], 100);
  const cov = parseNpy(fs.readFileSync(path.join(out, 'coverage.npy')));
  assert.ok(Math.abs(cov.data[0] - 0.25) < 1e-12);
});

test('cli: sum mode reports an additive total when partitioning', () => {
  const dir = tempDir();
  const values = Float64Array.from({ length: 16 }, (_, i) => i);
  fs.writeFileSync(path.join(dir, 'v.npy'), writeNpy(values, 4, 4));
  const out = path.join(dir, 'out');
  const r = run(['--input', path.join(dir, 'v.npy'), '--out', out,
    '--width', '2', '--height', '2', '--mode', 'sum']);
  assert.equal(r.status, 0, r.stderr);
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  assert.equal(meta.stats.integralConserved, true);
  assert.ok(Math.abs(meta.stats.outputIntegral - 120) < 1e-9);
});

test('cli: float32 output dtype is honoured', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'v.npy'), writeNpy(new Float64Array(4).fill(1.1), 2, 2));
  const out = path.join(dir, 'out');
  const r = run(['--input', path.join(dir, 'v.npy'), '--out', out,
    '--width', '1', '--height', '1', '--dtype', 'float32']);
  assert.equal(r.status, 0, r.stderr);
  const npy = parseNpy(fs.readFileSync(path.join(out, 'intensity.npy')));
  assert.equal(npy.dtype, '<f4');
});

test('cli: extent crop is flagged as non-partitioning', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'v.npy'), writeNpy(new Float64Array(64).fill(2), 8, 8));
  const out = path.join(dir, 'out');
  const r = run(['--input', path.join(dir, 'v.npy'), '--out', out,
    '--width', '2', '--height', '2', '--mode', 'sum', '--extent', '0,0,4,4']);
  assert.equal(r.status, 0, r.stderr);
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  assert.equal(meta.stats.integralConserved, false);
  assert.ok(meta.anomalies.some((a) => a.code === 'NON_PARTITIONING_GRID'));
});

test('cli: malformed extent is a hard error', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'v.npy'), writeNpy(new Float64Array(16), 4, 4));
  const r = run(['--input', path.join(dir, 'v.npy'), '--out', path.join(dir, 'o'),
    '--width', '2', '--height', '2', '--extent', '0,0,0,4']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /extent/);
});

test('cli: output grid is independent of the input shape', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'v.npy'), writeNpy(new Float64Array(16).fill(1), 4, 4));
  const out = path.join(dir, 'o');
  const r = run(['--input', path.join(dir, 'v.npy'), '--out', out,
    '--width', '13', '--height', '3']);
  assert.equal(r.status, 0, r.stderr);
  const npy = parseNpy(fs.readFileSync(path.join(out, 'intensity.npy')));
  assert.equal(npy.width, 13);
  assert.equal(npy.height, 3);
});

test('cli: mask dimension mismatch is rejected', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'v.npy'), writeNpy(new Float64Array(16), 4, 4));
  fs.writeFileSync(path.join(dir, 'm.npy'), writeNpy(new Float64Array(9), 3, 3));
  const r = run(['--input', path.join(dir, 'v.npy'), '--mask', path.join(dir, 'm.npy'),
    '--out', path.join(dir, 'o'), '--width', '2', '--height', '2']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mask dimensions/);
});

test('cli: help text mentions the GUI as primary entry point', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /GUI/);
});
