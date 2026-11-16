#!/usr/bin/env node
// Zero-dependency static server for the graphical page. Serves the repository
// root so /src/ui/index.html can read /cases/* fixtures and /src/core modules.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.npy': 'application/octet-stream',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  if (urlPath === '/') {
    res.writeHead(302, { Location: '/src/ui/index.html' });
    res.end();
    return;
  }
  const target = path.resolve(ROOT, '.' + urlPath);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Quantitative Float Resampler UI: http://${HOST}:${PORT}/`);
  console.log('Press Ctrl+C to stop.');
});
