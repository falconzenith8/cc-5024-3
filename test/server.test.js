import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 4321;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['tools/serve.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
  server.stdout.on('data', (d) => {
    if (d.toString().includes('http://')) { clearTimeout(timer); resolve(); }
  });
});

test.after(() => server.kill());

test('server: redirects root to the graphical page', async () => {
  const res = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/src/ui/index.html');
});

test('server: serves the UI with the right content types', async () => {
  const html = await fetch(`${BASE}/src/ui/index.html`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const text = await html.text();
  assert.match(text, /Quantitative Float Resampler/);

  const js = await fetch(`${BASE}/src/ui/main.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  const css = await fetch(`${BASE}/src/ui/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('server: serves bundled cases as binary with correct sizes', async () => {
  const json = await fetch(`${BASE}/cases/README.json`);
  assert.equal(json.status, 200);
  const meta = await json.json();
  assert.ok(meta.cases.length >= 6);
  for (const c of meta.cases) {
    const npy = await fetch(`${BASE}/cases/${c.name}/values.npy`);
    assert.equal(npy.status, 200, c.name);
    const buf = await npy.arrayBuffer();
    assert.ok(buf.byteLength > 128, `${c.name} npy too small`);
  }
});

test('server: blocks path traversal', async () => {
  const res = await fetch(`${BASE}/../../etc/passwd`, { redirect: 'manual' });
  assert.ok(res.status === 403 || res.status === 404 || res.status === 400);
});

test('server: 404 for missing files', async () => {
  const res = await fetch(`${BASE}/does/not/exist.js`);
  assert.equal(res.status, 404);
});

test('server: source modules load over HTTP for the browser', async () => {
  for (const mod of ['resample.js', 'npy.js', 'tiff.js', 'display.js', 'mask.js', 'output.js', 'reference.js']) {
    const res = await fetch(`${BASE}/src/core/${mod}`);
    assert.equal(res.status, 200, mod);
    const text = await res.text();
    assert.ok(text.length > 100, `${mod} appears empty`);
  }
});

test('server: HEAD-like range and cache headers are sane', async () => {
  const res = await fetch(`${BASE}/src/ui/index.html`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
