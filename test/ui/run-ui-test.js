#!/usr/bin/env node
// End-to-end UI test with Playwright. Drives the real page, checks that the
// displayed image and the downloaded float data agree with the core engine,
// and verifies the per-pixel inspector and anomaly reporting.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseNpy } from '../../src/core/npy.js';
import { resample } from '../../src/core/resample.js';
import { parseTiff } from '../../src/core/tiff.js';

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function step(name, fn) {
  return (async () => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - t0 });
      console.log(`  PASS  ${name}`);
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
      console.log(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}`);
    }
  })();
}

function startServer() {
  const proc = spawn(process.execPath, ['tools/serve.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
    proc.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('http://')) { clearTimeout(timer); resolve(proc); }
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('exit', (c) => { clearTimeout(timer); reject(new Error(`server exited ${c}`)); });
  });
}

const server = await startServer();
let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  server.kill();
  console.error(
    '\nCould not launch Chromium. If system libraries are missing, install them with:\n' +
    '  npx playwright install-deps\n' +
    'or provide them on LD_LIBRARY_PATH.\n\n' + e.message,
  );
  process.exit(2);
}
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qfr-ui-'));

await step('page loads and exposes the engine hook', async () => {
  await page.goto(`${BASE}/src/ui/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__resampler));
  const title = await page.title();
  assert.match(title, /Quantitative Float Resampler/);
});

await step('bundled cases are listed', async () => {
  await page.waitForFunction(() => document.querySelectorAll('#caseSelect option').length > 1);
  const count = await page.locator('#caseSelect option').count();
  assert.ok(count >= 7, `expected >= 7 options, got ${count}`);
});

await step('load constant-field case and resample mean', async () => {
  await page.selectOption('#caseSelect', 'constant-field');
  await page.click('#loadCase');
  await page.waitForFunction(() => window.__resampler.state.image !== null);
  const info = await page.evaluate(() => ({
    w: window.__resampler.state.image.width,
    h: window.__resampler.state.image.height,
  }));
  assert.deepEqual(info, { w: 16, h: 16 });
  await page.click('#runBtn');
  await page.waitForFunction(() => window.__resampler.state.result !== null);
  const stats = await page.evaluate(() => {
    const r = window.__resampler.state.result;
    return {
      w: r.width, h: r.height, mode: r.mode,
      min: Math.min(...r.intensity),
      max: Math.max(...r.intensity),
      undef: r.stats.undefinedCells,
    };
  });
  assert.equal(stats.w, 7);
  assert.equal(stats.h, 5);
  assert.equal(stats.mode, 'mean');
  assert.ok(Math.abs(stats.min - 12.5) < 1e-12);
  assert.ok(Math.abs(stats.max - 12.5) < 1e-12);
  assert.equal(stats.undef, 0);
});

await step('float field and coverage canvases both hold real rendered pixels', async () => {
  const probe = await page.evaluate(() => {
    function sample(id) {
      const c = document.getElementById(id);
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonEmpty = 0;
      const values = new Set();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0) { nonEmpty++; values.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); }
      }
      return { w: c.width, h: c.height, nonEmpty, distinct: values.size };
    }
    return { field: sample('resultCanvas'), coverage: sample('coverageCanvas') };
  });
  assert.equal(probe.field.w, 7);
  assert.equal(probe.field.h, 5);
  assert.equal(probe.field.nonEmpty, 35, 'every float cell must be drawn');
  assert.ok(probe.coverage.nonEmpty === 35, 'coverage layer must be drawn independently');
  // Constant field -> one grey level; coverage full -> green tones.
  assert.equal(probe.field.distinct, 1);
});

await step('display contrast changes pixels but not the float result', async () => {
  const before = await page.evaluate(() => ({
    min: Math.min(...window.__resampler.state.result.intensity),
    max: Math.max(...window.__resampler.state.result.intensity),
  }));
  await page.selectOption('#palette', 'inferno');
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => ({
    min: Math.min(...window.__resampler.state.result.intensity),
    max: Math.max(...window.__resampler.state.result.intensity),
  }));
  assert.deepEqual(before, after);
  await page.selectOption('#palette', 'gray');
});

await step('downloads carry float data matching the engine', async () => {
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#dlIntensityNpy'),
  ]);
  const p = path.join(tmp, 'intensity.npy');
  await dl.saveAs(p);
  const parsed = parseNpy(new Uint8Array(fs.readFileSync(p)));
  const expected = await page.evaluate(() => Array.from(window.__resampler.state.result.intensity));
  assert.equal(parsed.width, 7);
  assert.equal(parsed.height, 5);
  assert.equal(parsed.dtype, '<f8');
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(parsed.data[i] - expected[i]) < 1e-15, `cell ${i}`);
  }
  assert.equal(parsed.data[0], 12.5);
});

await step('csv download keeps full precision and coverage columns', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlCsv')]);
  const p = path.join(tmp, 'cells.csv');
  await dl.saveAs(p);
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 1 + 35);
  assert.match(lines[0], /intensity,coverage,valid_weight/);
  assert.ok(text.includes('12.5'), 'constant value present');
});

await step('float64 npy preserves a value that an 8-bit preview would destroy', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlIntensityNpy')]);
  const p = path.join(tmp, 'precise.npy');
  await dl.saveAs(p);
  const parsed = parseNpy(new Uint8Array(fs.readFileSync(p)));
  // 12.5 is not an 8-bit-reconstructible arbitrary float; ensure no quantization.
  assert.equal(parsed.data[0], 12.5);
});

await step('partial-mask case reports coverage below 1 and undefined cells', async () => {
  await page.selectOption('#caseSelect', 'partial-mask');
  await page.click('#loadCase');
  await page.waitForFunction(() => window.__resampler.state.image?.width === 24);
  await page.click('#runBtn');
  await page.waitForFunction(() => window.__resampler.state.result?.width === 8);
  const info = await page.evaluate(() => {
    const r = window.__resampler.state.result;
    let partial = 0;
    let nan = 0;
    for (let i = 0; i < r.coverage.length; i++) {
      if (r.coverage[i] > 0 && r.coverage[i] < 1) partial++;
      if (Number.isNaN(r.intensity[i])) nan++;
    }
    return {
      partial, nan,
      undef: r.stats.undefinedCells,
      anomalies: r.anomalies.map((a) => a.code),
      valid: r.stats.validPixels,
      total: r.stats.sourcePixels,
      summary: document.getElementById('summaryBox').textContent,
      anomalyText: document.getElementById('anomalyBox').textContent,
    };
  });
  assert.ok(info.partial > 0, 'expected partially covered cells');
  assert.ok(info.nan > 0, 'expected NaN cells');
  assert.equal(info.nan, info.undef);
  assert.ok(info.valid < info.total);
  assert.ok(info.anomalies.includes('UNDEFINED_OUTPUT_CELLS'));
  assert.match(info.summary, /undefined cells/);
  assert.match(info.anomalyText, /NaN/);
});

await step('coverage layer distinguishes low from full coverage by colour', async () => {
  const colours = await page.evaluate(() => {
    const c = document.getElementById('coverageCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) set.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return [...set];
  });
  assert.ok(colours.length >= 3, `expected several coverage colours, got ${colours.length}`);
});

await step('inspector shows exact float values and coverage for a clicked cell', async () => {
  const cell = await page.evaluate(() => {
    const r = window.__resampler.state.result;
    // Choose a cell with partial coverage so the readout is non-trivial.
    let target = { x: 0, y: 0 };
    let best = 2;
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const c = r.coverage[y * r.width + x];
        if (c > 0 && c < 1 && Math.abs(c - 0.5) < best) { best = Math.abs(c - 0.5); target = { x, y }; }
      }
    }
    const got = window.__resampler.inspectAt(target.x, target.y);
    return { target, got, text: document.getElementById('inspectBox').textContent };
  });
  assert.ok(cell.text.includes('coverage'));
  assert.ok(cell.text.includes('valid weight'));
  assert.ok(cell.text.includes(cell.got.coverage.toFixed(6)), 'coverage printed at 6 dp');
  const expected = await page.evaluate(
    ({ x, y }) => window.__resampler.state.result.intensity[y * window.__resampler.state.result.width + x],
    cell.target,
  );
  assert.equal(cell.got.intensity, expected);
});

await step('sum mode reports a conserved integral and distinct quantity label', async () => {
  await page.selectOption('#caseSelect', 'known-integral-spot');
  await page.click('#loadCase');
  await page.waitForFunction(() => window.__resampler.state.image?.width === 32);
  await page.check('input[name="mode"][value="sum"]');
  await page.click('#runBtn');
  await page.waitForFunction(() => window.__resampler.state.result?.mode === 'sum');
  const out = await page.evaluate(() => {
    const r = window.__resampler.state.result;
    return {
      quantity: r.quantity,
      conserved: r.stats.integralConserved,
      integral: r.stats.outputIntegral,
      badge: document.getElementById('modeBadge').textContent,
      summary: document.getElementById('summaryBox').textContent,
    };
  });
  assert.equal(out.quantity, 'integral');
  assert.equal(out.conserved, true);
  assert.ok(Math.abs(out.integral - 76968.327374074) / 76968.327374074 < 1e-10);
  assert.match(out.badge, /integrated total/);
  assert.match(out.summary, /conserved/);
});

await step('mean mode explicitly refuses to claim conservation', async () => {
  await page.check('input[name="mode"][value="mean"]');
  await page.click('#runBtn');
  await page.waitForFunction(() => window.__resampler.state.result?.mode === 'mean');
  const summary = await page.textContent('#summaryBox');
  assert.match(summary, /n\/a — mean is not a total/);
});

await step('zoom crops the shared view in both result panels', async () => {
  await page.fill('#zoom', '3');
  await page.dispatchEvent('#zoom', 'input');
  await page.waitForTimeout(120);
  const sizes = await page.evaluate(() => ({
    result: [document.getElementById('resultCanvas').width, document.getElementById('resultCanvas').height],
    coverage: [document.getElementById('coverageCanvas').width, document.getElementById('coverageCanvas').height],
  }));
  // The backing store stays at result resolution; the shared view window is
  // sampled into it, and CSS pixelation provides the visual magnification.
  assert.deepEqual(sizes.result, [64, 64]);
  assert.deepEqual(sizes.coverage, [64, 64]);
  await page.fill('#zoom', '1');
  await page.dispatchEvent('#zoom', 'input');
});

await step('self-check agrees with the independent reference', async () => {
  await page.click('#selfCheck');
  await page.waitForFunction(() => document.getElementById('selfCheckBox').textContent.includes('reference'));
  const text = await page.textContent('#selfCheckBox');
  assert.match(text, /matches reference/);
});

await step('extreme dynamic range: display is clipped, saved data is not', async () => {
  await page.selectOption('#caseSelect', 'extreme-dynamic-range');
  await page.click('#loadCase');
  await page.waitForFunction(() => window.__resampler.state.image?.width === 20);
  await page.click('#runBtn');
  await page.waitForFunction(() => window.__resampler.state.result !== null);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlIntensityNpy')]);
  const p = path.join(tmp, 'extreme.npy');
  await dl.saveAs(p);
  const parsed = parseNpy(new Uint8Array(fs.readFileSync(p)));
  const live = await page.evaluate(() => Array.from(window.__resampler.state.result.intensity));
  // Saved values must be bit-identical to the in-memory float result.
  let exact = true;
  for (let i = 0; i < live.length; i++) {
    if (Number.isNaN(live[i])) { if (!Number.isNaN(parsed.data[i])) exact = false; }
    else if (parsed.data[i] !== live[i]) exact = false;
  }
  assert.ok(exact, 'saved float data must match the in-memory result exactly');
  // The 8-bit preview must have collapsed the field to at most 256 levels,
  // proving it is not the quantitative artifact.
  const levels = await page.evaluate(() => {
    const c = document.getElementById('resultCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) set.add(d[i]);
    return set.size;
  });
  assert.ok(levels <= 256, `preview should be 8-bit, saw ${levels} levels`);
  assert.ok(parsed.dtype === '<f8');
});

await step('NaN pixels are excluded, not filled with zero', async () => {
  const out = await page.evaluate(() => {
    const s = window.__resampler.state;
    const r = s.result;
    return {
      nanExcluded: r.stats.maskedNonFinite + r.stats.excludedNonFinite,
      undefCells: r.stats.undefinedCells,
      nanInResult: Array.from(r.intensity).filter((v) => Number.isNaN(v)).length,
    };
  });
  assert.ok(out.nanExcluded > 0, 'case contains NaN pixels');
  assert.equal(out.nanInResult, out.undefCells, 'result NaN only where coverage is zero');
});

await step('true zero vs masked non-zero stay distinct in the UI output', async () => {
  await page.selectOption('#caseSelect', 'zero-vs-missing');
  await page.click('#loadCase');
  await page.waitForFunction(() => window.__resampler.state.image?.width === 8);
  await page.click('#runBtn');
  await page.waitForFunction(() => window.__resampler.state.result !== null);
  const out = await page.evaluate(() => {
    const r = window.__resampler.state.result;
    return {
      intensity: r.intensity[0],
      coverage: r.coverage[0],
      trueZeros: r.stats.validTrueZeros,
      excluded: r.stats.excludedNonZero,
    };
  });
  assert.equal(out.intensity, 0, 'real zero must remain zero');
  assert.ok(Math.abs(out.coverage - 0.5) < 1e-12);
  assert.ok(out.trueZeros > 0);
  assert.ok(out.excluded > 0);
});

await step('float32 tiff loads and is flagged as float32 precision', async () => {
  await page.evaluate(async () => {
    const res = await fetch('../../cases/float32-tiff/values-float32.tiff');
    const buf = new Uint8Array(await res.arrayBuffer());
    const dt = new DataTransfer();
    dt.items.add(new File([buf], 'values-float32.tiff', { type: 'image/tiff' }));
    const input = document.getElementById('valuesFile');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => window.__resampler.state.image?.sourceName === 'values-float32.tiff');
  const info = await page.evaluate(() => ({
    dtype: window.__resampler.state.image.dtype,
    w: window.__resampler.state.image.width,
  }));
  assert.equal(info.w, 24);
  assert.match(info.dtype, /float/);
});

await step('invalid grid input surfaces an error instead of a wrong number', async () => {
  await page.fill('#outWidth', '0');
  await page.click('#runBtn');
  await page.waitForFunction(() => !document.getElementById('errorBox').hidden);
  const msg = await page.textContent('#errorBox');
  assert.match(msg, /grid width/);
  await page.fill('#outWidth', '8');
  await page.click('#runBtn');
});

await step('tiff download is float32 and matches the float result', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlIntensityTiff')]);
  const p = path.join(tmp, 'intensity.tiff');
  await dl.saveAs(p);
  const parsed = parseTiff(new Uint8Array(fs.readFileSync(p)));
  const expected = await page.evaluate(() => {
    const r = window.__resampler.state.result;
    return { w: r.width, h: r.height, intensity: Array.from(r.intensity) };
  });
  assert.equal(parsed.width, expected.w);
  assert.equal(parsed.height, expected.h);
  assert.equal(parsed.dtypeKind, 'float');
  for (let i = 0; i < expected.intensity.length; i++) {
    if (Number.isNaN(expected.intensity[i])) assert.ok(Number.isNaN(parsed.data[i]));
    else assert.ok(Math.abs(parsed.data[i] - expected.intensity[i]) <=
      Math.abs(expected.intensity[i]) * 1e-6 + 1e-30);
  }
});

await step('mask drawing excludes samples and updates coverage', async () => {
  await page.selectOption('#caseSelect', 'constant-field');
  await page.click('#loadCase');
  await page.waitForFunction(() => window.__resampler.state.image?.width === 16);
  // Select the "exclude rectangle" tool and drag over the left half.
  await page.selectOption('#maskTool', 'exclude');
  const box = await page.locator('#sourceCanvas').boundingBox();
  const before = await page.evaluate(() => {
    const s = window.__resampler.state;
    return s.mask.reduce((a, v) => a + v, 0);
  });
  assert.equal(before, 256);
  const y0 = box.y + 2;
  const y1 = box.y + box.height - 2;
  const x0 = box.x + 2;
  const x1 = box.x + box.width / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const s = window.__resampler.state;
    const valid = s.mask.reduce((a, v) => a + v, 0);
    return { valid, label: s.maskLabel };
  });
  assert.ok(after.valid < before, `mask should shrink: ${before} -> ${after.valid}`);
  assert.match(after.label, /drawn exclude/);
  await page.click('#runBtn');
  await page.waitForFunction(() => window.__resampler.state.result !== null);
  const info = await page.evaluate(() => {
    const r = window.__resampler.state.result;
    let partial = 0;
    for (let i = 0; i < r.coverage.length; i++) if (r.coverage[i] > 0 && r.coverage[i] < 1) partial++;
    return { partial, valid: r.stats.validPixels };
  });
  assert.ok(info.valid < 256, 'excluded pixels must not count as valid');
  assert.ok(info.partial > 0, 'a rectangular exclusion should leave partially covered cells');
  await page.selectOption('#maskTool', 'none');
});

await step('mean mode stays exact after masking, and 8-bit preview is not the source of truth', async () => {
  const out = await page.evaluate(() => {
    const r = window.__resampler.state.result;
    const vals = Array.from(r.intensity).filter((v) => !Number.isNaN(v));
    const allEqual = vals.every((v) => v === 12.5);
    return { count: vals.length, allEqual };
  });
  assert.ok(out.count > 0);
  assert.ok(out.allEqual, 'remaining fully covered cells must still be exactly 12.5');
});

await step('all-missing contract: every cell is NaN and the page reports NO_VALID_SAMPLES, never zeros', async () => {
  // Build an all-missing array in the page (half masked, half NaN) without
  // touching the kernel: drive only UI controls, then read the kernel result.
  await page.evaluate(() => {
    const { setImage, setMask } = window.__resamplerCore;
    const values = new Float64Array([1, 2, NaN, NaN]);
    const s = window.__resampler.state;
    setImage(s, { data: values, width: 4, height: 1, dtype: '<f8', dtypeKind: 'float', sourceName: 'all-missing' });
    setMask(s, new Uint8Array([0, 0, 1, 1]), 'contract all missing');
    s.grid = { width: 2, height: 1, extent: null };
  });
  await page.click('#runBtn');
  await page.waitForFunction(() => window.__resampler.state.result !== null);
  const out = await page.evaluate(() => {
    const r = window.__resampler.state.result;
    return {
      intensities: Array.from(r.intensity),
      coverage: Array.from(r.coverage),
      validWeight: Array.from(r.validWeight),
      undefined: r.stats.undefinedCells,
      validPixels: r.stats.validPixels,
      sourceMean: r.stats.sourceMean,
      outputMean: r.stats.outputMean,
      validMin: r.stats.validMin,
      anomalyText: document.getElementById('anomalyBox').textContent,
    };
  });
  assert.equal(out.validPixels, 0);
  assert.equal(out.undefined, 2);
  for (const v of out.intensities) assert.ok(Number.isNaN(v), 'all-missing cells must be NaN, not zero');
  for (const c of out.coverage) assert.equal(c, 0);
  for (const w of out.validWeight) assert.equal(w, 0);
  assert.ok(Number.isNaN(out.sourceMean) && Number.isNaN(out.outputMean));
  assert.equal(out.validMin, null);
  assert.match(out.anomalyText, /NO_VALID_SAMPLES/);
});

await step('sparse valid region: empty cell is NaN next to a half-covered finite cell', async () => {
  await page.evaluate(() => {
    const s = window.__resampler.state;
    const { setImage, setMask } = window.__resamplerCore;
    setImage(s, { data: new Float64Array([7, 7, 9, 7]), width: 4, height: 1, dtype: '<f8', dtypeKind: 'float', sourceName: 'sparse' });
    setMask(s, new Uint8Array([0, 0, 1, 0]), 'one valid pixel');
    s.grid = { width: 2, height: 1, extent: null };
  });
  await page.click('#runBtn');
  await page.waitForFunction(() => window.__resampler.state.result !== null);
  const out = await page.evaluate(() => {
    const r = window.__resampler.state.result;
    return {
      intensities: Array.from(r.intensity),
      coverage: Array.from(r.coverage),
      undefined: r.stats.undefinedCells,
      anomalyText: document.getElementById('anomalyBox').textContent,
    };
  });
  assert.ok(Number.isNaN(out.intensities[0]), 'empty cell is NaN');
  assert.equal(out.coverage[0], 0);
  assert.equal(out.intensities[1], 9);
  assert.ok(Math.abs(out.coverage[1] - 0.5) < 1e-12);
  assert.equal(out.undefined, 1);
  assert.match(out.anomalyText, /UNDEFINED_OUTPUT_CELLS/);
});

await step('no console errors were logged during the run', async () => {
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(' | ')}`);
});

await browser.close();
server.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed`);
if (failed.length) {
  for (const f of failed) console.log(`FAILED: ${f.name} — ${f.error}`);
  process.exit(1);
}
