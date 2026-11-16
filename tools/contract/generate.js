#!/usr/bin/env node
// Generates the runnable validity-contract examples under docs/contract/.
//
// One script invocation produces every artifact for every scenario:
//   scenario-<id>.svg  source state, float field and coverage side by side
//   scenario-<id>.csv  full-precision numeric table of the same run
//   scenario-<id>.json per-cell values plus stats and anomaly codes
//   manifest.json      SHA-255 of each artifact, proving the image and the
//                      numeric table come from this single run
//
// Deterministic: no timestamps and no randomness, so re-running on a clean
// checkout reproduces byte-identical files. No-data cells are written as the
// literal token "nan"; the generator never substitutes zero.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runChecks } from './run-checks.js';
import { CONTRACT_SCENARIOS } from './scenarios.js';
import { formatNumber } from '../../src/core/output.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', '..', 'docs', 'contract');
const CELL = 64;
const GAP = 24;
const LABEL_H = 26;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function rect(x, y, w, h, fill, extra = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
}

function text(x, y, s, opts = {}) {
  const size = opts.size || 13;
  const weight = opts.weight ? ` font-weight="${opts.weight}"` : '';
  const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : '';
  return `<text x="${x}" y="${y}" font-family="monospace" font-size="${size}"${weight}${anchor} fill="${opts.fill || '#e6e6e6'}">${esc(s)}</text>`;
}

// Gray ramp for finite float values; explicit colours for the three states.
function fieldFill(v, defined, min, max) {
  if (!defined) return '#7860a0'; // undefined: same purple family as the UI
  if (Number.isNaN(v)) return '#7860a0';
  const span = max - min;
  const t = span > 0 ? (v - min) / span : 0.5;
  const g = Math.round(40 + t * 200);
  return `rgb(${g},${g},${g})`;
}

function coverageFill(c, defined) {
  if (!defined) return '#7860a0';
  if (c <= 0) return '#dc3c28';
  if (c >= 1) return '#28a850';
  // red -> amber -> green proportional to the coverage fraction.
  const r = Math.round(220 - c * 180);
  const g = Math.round(60 + c * 175);
  return `rgb(${r},${g},40)`;
}

function sourceStateFill(scenario, p) {
  const v = scenario.values[p];
  const valid = scenario.mask[p] !== 0;
  if (!valid) return '#c8403a'; // masked out
  if (!Number.isFinite(v)) return '#e0a030'; // NaN/Inf inside mask -> missing
  if (v === 0) return '#3a6ea5'; // real zero, a valid measurement
  return '#4a4a4a';
}

function renderSvg(scenario, report) {
  const { result } = report;
  const w = scenario.width;
  const rows = [
    { label: 'source state', width: w, cells: (p) => sourceStateFill(scenario, p), caption: (p) => stateToken(scenario, p) },
    { label: 'float field', width: result.width, cells: (p) => fieldFill(result.intensity[p], result.defined[p] === 1, finiteMin(result), finiteMax(result)), caption: (p) => (result.defined[p] ? formatNumber(result.intensity[p]) : 'nan') },
    { label: 'coverage', width: result.width, cells: (p) => coverageFill(result.coverage[p], result.defined[p] === 1), caption: (p) => result.coverage[p].toFixed(3) },
  ];
  const panelW = Math.max(w, result.width) * CELL;
  const svgW = rows.length * panelW + (rows.length + 1) * GAP;
  const svgH = LABEL_H + CELL + 46 + 58;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">`,
    rect(0, 0, svgW, svgH, '#1e1e1e'),
    text(GAP, 20, scenario.id, { size: 15, weight: 700 }),
  ];
  rows.forEach((row, ri) => {
    const ox = GAP + ri * (panelW + GAP);
    parts.push(text(ox, LABEL_H + 8, row.label, { size: 12, weight: 700 }));
    for (let p = 0; p < row.width; p++) {
      parts.push(rect(ox + p * CELL, LABEL_H + 16, CELL - 2, CELL - 2, row.cells(p), 'stroke="#111" stroke-width="1"'));
      parts.push(text(ox + p * CELL + 6, LABEL_H + 36, row.caption(p), { size: 11 }));
    }
  });
  // Legend.
  const legendY = LABEL_H + CELL + 34;
  const legend = [
    ['#3a6ea5', 'valid true zero'],
    ['#4a4a4a', 'valid finite'],
    ['#e0a030', 'NaN/Inf -> missing'],
    ['#c8403a', 'masked out'],
    ['#7860a0', 'undefined output (NaN, not 0)'],
  ];
  let lx = GAP;
  for (const [colour, label] of legend) {
    parts.push(rect(lx, legendY, 14, 14, colour));
    parts.push(text(lx + 18, legendY + 11, label, { size: 11 }));
    lx += 22 + label.length * 7.2;
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function stateToken(scenario, p) {
  const v = scenario.values[p];
  if (scenario.mask[p] === 0) return 'mask';
  if (!Number.isFinite(v)) return 'nan';
  return formatNumber(v);
}

function finiteMin(result) {
  let m = Infinity;
  for (const v of result.intensity) if (Number.isFinite(v) && v < m) m = v;
  return Number.isFinite(m) ? m : 0;
}
function finiteMax(result) {
  let m = -Infinity;
  for (const v of result.intensity) if (Number.isFinite(v) && v > m) m = v;
  return Number.isFinite(m) ? m : 1;
}

function renderCsv(report) {
  const { result } = report;
  const head = 'x,y,defined,intensity,coverage,valid_weight,overlap_sum\n';
  const lines = [];
  for (let y = 0; y < result.height; y++) {
    for (let x = 0; x < result.width; x++) {
      const i = y * result.width + x;
      lines.push([
        x,
        y,
        result.defined[i],
        result.defined[i] ? formatNumber(result.intensity[i]) : 'nan',
        formatNumber(result.coverage[i]),
        formatNumber(result.validWeight[i]),
        formatNumber(result.overlapSum[i]),
      ].join(','));
    }
  }
  return head + lines.join('\n') + '\n';
}

function renderJson(scenario, report) {
  const { result } = report;
  return JSON.stringify({
    scenario: scenario.id,
    title: scenario.title,
    source: {
      width: scenario.width,
      height: scenario.height,
      values: Array.from(scenario.values, (v) => (Number.isNaN(v) ? 'nan' : v)),
      mask: Array.from(scenario.mask),
    },
    grid: { width: result.width, height: result.height, extent: result.extent, mode: result.mode },
    stats: result.stats,
    anomalies: result.anomalies,
    cells: report.evidence[0].cells.map((c) => ({
      ...c,
      // Emit the explicit token rather than JSON's silent NaN -> null, so a
      // missing cell cannot be confused with a legitimate null statistic.
      intensity: Number.isNaN(c.intensity) ? 'nan' : c.intensity,
    })),
  }, null, 2) + '\n';
}

fs.mkdirSync(OUT, { recursive: true });
const reports = runChecks();
const failed = reports.filter((r) => !r.ok);
if (failed.length) {
  for (const r of failed) {
    process.stderr.write(`contract scenario ${r.id} fails before artifacts can be generated:\n`);
    for (const f of r.failures) process.stderr.write(`  - ${f}\n`);
  }
  process.exit(1);
}

const manifest = { generatedBy: 'tools/contract/generate.js', scenarios: [] };
for (let i = 0; i < reports.length; i++) {
  const scenario = CONTRACT_SCENARIOS[i];
  const report = reports[i];
  const files = {
    svg: `scenario-${scenario.id}.svg`,
    csv: `scenario-${scenario.id}.csv`,
    json: `scenario-${scenario.id}.json`,
  };
  const artifacts = [
    [files.svg, renderSvg(scenario, report)],
    [files.csv, renderCsv(report)],
    [files.json, renderJson(scenario, report)],
  ];
  const entry = { id: scenario.id, title: scenario.title, files: {}, evidence: report.evidence[0] };
  for (const [name, content] of artifacts) {
    const bytes = new TextEncoder().encode(content);
    fs.writeFileSync(path.join(OUT, name), bytes);
    entry.files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  manifest.scenarios.push(entry);
}
const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'manifest.json'), manifestBytes);
process.stdout.write(`generated ${reports.length} contract scenarios in ${OUT}\n`);
for (const e of manifest.scenarios) {
  process.stdout.write(`  ${e.id}: ${e.evidence.cells.length} cells, ` +
    `${e.evidence.undefinedCells} undefined, coverage sum ${e.evidence.totalOverlapArea}\n`);
}
process.stdout.write(`manifest sha256 ${sha256(manifestBytes)}\n`);
