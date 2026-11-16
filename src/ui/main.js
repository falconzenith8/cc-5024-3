import { parseNpy, writeNpy } from '../core/npy.js';
import { parseTiff, writeTiff, detectFormat } from '../core/tiff.js';
import {
  createState, setImage, setMask, runResample, buildDisplay,
  projectedCoverage, inspectCell, validateSettings,
} from './controller.js';
import { maskFromFinite, createMask, maskStats } from '../core/mask.js';
import {
  resultToCsv, resultToJson, intensityNpy, coverageNpy, validWeightNpy,
} from '../core/output.js';
import { referenceResampleExact, maxAbsDiff } from '../core/reference.js';

const $ = (id) => document.getElementById(id);
const state = createState();
let lastDisplay = null;
let caseIndex = null;
let drawState = null;
let view = { zoom: 1, focusX: 0.5, focusY: 0.5 };
let activeCell = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init();

async function init() {
  wireEvents();
  $('algoTag').textContent = 'engine: area-weighted-mask-aware v1.0.0';
  await loadCaseIndex();
}

async function loadCaseIndex() {
  try {
    const res = await fetch('../../cases/README.json', { cache: 'no-store' });
    if (!res.ok) return;
    caseIndex = await res.json();
    const sel = $('caseSelect');
    for (const c of caseIndex.cases) {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = `${c.name} (${c.width}×${c.height}${c.maskPresent ? ' + mask' : ''})`;
      sel.appendChild(opt);
    }
  } catch {
    // Cases are optional; the page works with user files alone.
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function wireEvents() {
  $('valuesFile').addEventListener('change', (e) => loadValuesFile(e.target.files[0]));
  $('maskFile').addEventListener('change', (e) => loadMaskFile(e.target.files[0]));
  $('loadCase').addEventListener('click', loadSelectedCase);
  $('caseSelect').addEventListener('change', () => {
    $('loadCase').disabled = !$('caseSelect').value;
  });
  $('loadCase').disabled = true;

  $('maskTool').addEventListener('change', () => {
    $('drawHint').hidden = $('maskTool').value === 'none';
    $('sourceCanvas').style.cursor = $('maskTool').value === 'none' ? 'crosshair' : 'cell';
  });
  $('maskAll').addEventListener('click', () => applyMask(createMask(state.image.width, state.image.height, 1), 'all valid'));
  $('maskNone').addEventListener('click', () => applyMask(createMask(state.image.width, state.image.height, 0), 'all invalid'));
  $('maskFinite').addEventListener('click', () => applyMask(maskFromFinite(state.image.values), 'finite only'));
  $('maskInvert').addEventListener('click', () => {
    const m = Uint8Array.from(state.mask, (v) => (v ? 0 : 1));
    applyMask(m, 'inverted');
  });

  for (const id of ['outWidth', 'outHeight', 'extX0', 'extY0', 'extX1', 'extY1']) {
    $(id).addEventListener('input', markStale);
  }
  $('useExtent').addEventListener('change', () => {
    $('extentRow').hidden = !$('useExtent').checked;
    markStale();
  });
  document.querySelectorAll('[data-scale]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.image) return;
      const s = Number(btn.dataset.scale);
      $('outWidth').value = Math.max(1, Math.round(state.image.width * s));
      $('outHeight').value = Math.max(1, Math.round(state.image.height * s));
      markStale();
    });
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      state.mode = document.querySelector('input[name="mode"]:checked').value;
      const isSum = state.mode === 'sum';
      $('compensate').disabled = !isSum;
      if (!isSum) $('compensate').checked = false;
      updateSemanticsHint();
      markStale();
    });
  });
  $('compensate').addEventListener('change', markStale);
  $('pixelArea').addEventListener('input', markStale);

  for (const id of ['palette', 'scale', 'lowPct', 'highPct', 'lowCoverage']) {
    $(id).addEventListener('input', () => {
      readDisplaySettings();
      if (state.result) renderAll();
    });
  }
  for (const id of ['showSource', 'showSourceMask', 'showResult', 'showCoverage']) {
    $(id).addEventListener('change', () => renderAll());
  }
  $('zoom').addEventListener('input', () => {
    view.zoom = Number($('zoom').value);
    $('zoomLabel').textContent = `${view.zoom}×`;
    renderAll();
  });
  $('runBtn').addEventListener('click', doRun);
  $('exampleBtn').addEventListener('click', runExample);
  $('selfCheck').addEventListener('click', runSelfCheck);

  $('dlIntensityNpy').addEventListener('click', () => saveBlob(intensityNpy(state.result, 'float64'), 'intensity.npy'));
  $('dlIntensityNpy32').addEventListener('click', () => saveBlob(intensityNpy(state.result, 'float32'), 'intensity-float32.npy'));
  $('dlCoverageNpy').addEventListener('click', () => saveBlob(coverageNpy(state.result), 'coverage.npy'));
  $('dlWeightNpy').addEventListener('click', () => saveBlob(validWeightNpy(state.result), 'valid_weight.npy'));
  $('dlCsv').addEventListener('click', () => saveBlob(new TextEncoder().encode(resultToCsv(state.result)), 'cells.csv'));
  $('dlMeta').addEventListener('click', () => saveBlob(new TextEncoder().encode(resultToJson(state.result, buildMetaExtra())), 'meta.json'));
  $('dlIntensityTiff').addEventListener('click', () => saveBlob(writeTiff(state.result.intensity, state.result.width, state.result.height, { dtype: 'float32', description: 'Float resampling intensity; display images are not quantitative.' }), 'intensity.tiff'));

  const sourceCanvas = $('sourceCanvas');
  sourceCanvas.addEventListener('mousedown', onCanvasDown);
  window.addEventListener('mousemove', onWindowMove);
  window.addEventListener('mouseup', onWindowUp);
  $('resultCanvas').addEventListener('click', onResultClick);
  $('coverageCanvas').addEventListener('click', onResultClick);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
async function loadValuesFile(file) {
  if (!file) return;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const fmt = detectFormat(buf);
    let parsed;
    if (fmt === 'npy') parsed = parseNpy(buf);
    else if (fmt === 'tiff') parsed = parseTiff(buf);
    else throw new Error('Unrecognised file: expected .npy or uncompressed .tiff');
    parsed.sourceName = file.name;
    adoptImage(parsed);
  } catch (e) {
    showError(`Could not load values: ${e.message}`);
  }
}

async function loadMaskFile(file) {
  if (!file) return;
  if (!state.image) { showError('Load the values image before a mask.'); return; }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const parsed = parseNpy(buf);
    if (parsed.width !== state.image.width || parsed.height !== state.image.height) {
      throw new Error(`mask is ${parsed.width}×${parsed.height}, image is ${state.image.width}×${state.image.height}`);
    }
    const m = new Uint8Array(parsed.data.length);
    for (let i = 0; i < m.length; i++) m[i] = parsed.data[i] !== 0 ? 1 : 0;
    applyMask(m, file.name);
  } catch (e) {
    showError(`Could not load mask: ${e.message}`);
  }
}

async function loadSelectedCase() {
  const name = $('caseSelect').value;
  if (!name) return;
  try {
    const base = `../../cases/${name}`;
    const meta = await (await fetch(`${base}/case.json`)).json();
    const vbuf = new Uint8Array(await (await fetch(`${base}/values.npy`)).arrayBuffer());
    const parsed = parseNpy(vbuf);
    parsed.sourceName = `${name}/values.npy`;
    adoptImage(parsed);
    if (meta.maskPresent) {
      const mbuf = new Uint8Array(await (await fetch(`${base}/mask.npy`)).arrayBuffer());
      const m = parseNpy(mbuf);
      const mask = new Uint8Array(m.data.length);
      for (let i = 0; i < mask.length; i++) mask[i] = m.data[i] !== 0 ? 1 : 0;
      applyMask(mask, 'bundled mask');
    }
    if (meta.gridSuggestion) {
      $('outWidth').value = meta.gridSuggestion.width;
      $('outHeight').value = meta.gridSuggestion.height;
      if (meta.gridSuggestion.extent) {
        $('useExtent').checked = true;
        $('extentRow').hidden = false;
        const [x0, y0, x1, y1] = meta.gridSuggestion.extent;
        $('extX0').value = x0; $('extY0').value = y0; $('extX1').value = x1; $('extY1').value = y1;
      } else {
        $('useExtent').checked = false;
        $('extentRow').hidden = true;
      }
    }
    if (meta.semanticsSuggestion) {
      const r = document.querySelector(`input[name="mode"][value="${meta.semanticsSuggestion}"]`);
      if (r) { r.checked = true; r.dispatchEvent(new Event('change')); }
    }
    readGridSettings();
    $('dataInfo').textContent =
      `${parsed.width}×${parsed.height} · ${parsed.dtype || 'unknown'} · ${name}` +
      (meta.description ? ` — ${meta.description}` : '');
    $('dataInfo').classList.remove('warn');
    state.result = null;
    renderAll();
    updateButtons();
    if (meta.expected) {
      $('selfCheckBox').textContent = 'Case loaded. Press Resample to compute; expected values are in case.json.';
    }
  } catch (e) {
    showError(`Could not load case "${name}": ${e.message}`);
  }
}

function adoptImage(parsed) {
  setImage(state, parsed);
  $('outWidth').value = parsed.width;
  $('outHeight').value = parsed.height;
  $('useExtent').checked = false;
  $('extentRow').hidden = true;
  updateMaskInfo();
  updateButtons();
  markStale();
}

// ---------------------------------------------------------------------------
// Mask application
// ---------------------------------------------------------------------------
function applyMask(mask, label) {
  if (!state.image) { showError('Load an image first.'); return; }
  setMask(state, mask, label);
  updateMaskInfo();
  markStale();
}

function updateMaskInfo() {
  if (!state.image) { $('maskInfo').textContent = 'mask: none'; return; }
  const s = maskStats(state.mask);
  const pct = ((s.valid / s.total) * 100).toFixed(1);
  $('maskInfo').textContent =
    `mask: ${state.maskLabel} · valid ${s.valid}/${s.total} (${pct}%) · excluded ${s.invalid}`;
}

// ---------------------------------------------------------------------------
// Grid / settings read
// ---------------------------------------------------------------------------
function readGridSettings() {
  state.grid.width = parseInt($('outWidth').value, 10) || 0;
  state.grid.height = parseInt($('outHeight').value, 10) || 0;
  if ($('useExtent').checked) {
    state.grid.extent = [
      parseFloat($('extX0').value), parseFloat($('extY0').value),
      parseFloat($('extX1').value), parseFloat($('extY1').value),
    ];
  } else {
    state.grid.extent = null;
  }
  state.mode = document.querySelector('input[name="mode"]:checked').value;
  state.compensate = $('compensate').checked;
  state.pixelArea = parseFloat($('pixelArea').value);
  state.lowCoverage = parseFloat($('lowCoverage').value);
}

function readDisplaySettings() {
  state.display.palette = $('palette').value;
  state.display.scale = $('scale').value;
  state.display.lowPercentile = parseFloat($('lowPct').value);
  state.display.highPercentile = parseFloat($('highPct').value);
  state.lowCoverage = parseFloat($('lowCoverage').value);
}

function updateSemanticsHint() {
  const hint = $('semanticsHint');
  if (state.mode === 'sum') {
    hint.textContent =
      'Integrated totals are additive only when the output footprints partition the usable source pixels. ' +
      'A partial crop or a non-partitioning grid will be flagged.';
    hint.classList.add('warn');
  } else {
    hint.textContent = 'Mean intensity and integrated total are different quantities. A resampled mean is not a conserved total.';
    hint.classList.remove('warn');
  }
}

function markStale() {
  if (!state.image) return;
  readGridSettings();
  updateButtons();
  $('modeBadge').textContent = state.result ? 'stale — rerun' : 'ready';
  $('modeBadge').classList.remove('active');
  $('selfCheck').disabled = true;
}

function updateButtons() {
  const ready = Boolean(state.image);
  $('runBtn').disabled = !ready;
  $('exampleBtn').disabled = !ready;
  $('selfCheck').disabled = !state.result;
  const hasResult = Boolean(state.result);
  for (const id of ['dlIntensityNpy', 'dlIntensityNpy32', 'dlCoverageNpy', 'dlWeightNpy', 'dlCsv', 'dlMeta', 'dlIntensityTiff']) {
    $(id).disabled = !hasResult;
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function doRun() {
  readGridSettings();
  const errs = validateSettings(state);
  if (errs.length > 0) { showError(errs.join('\n')); return; }
  const prior = state.result;
  let out;
  try {
    out = runResample(state);
  } catch (e) {
    showError(`Resampling failed: ${e.message}`);
    return;
  }
  if (!out.ok) { showError(out.errors.join('\n')); return; }
  clearError();
  activeCell = null;
  const r = state.result;
  $('modeBadge').textContent =
    r.mode === 'mean' ? `mean intensity · ${r.width}×${r.height}` : `integrated total · ${r.width}×${r.height}`;
  $('modeBadge').classList.add('active');
  $('selfCheck').disabled = false;
  updateButtons();
  renderAll();
  renderSummary(prior);
  renderAnomalies();
  $('inspectBox').textContent = 'Click a result pixel to inspect.';
}

function runExample() {
  if (!state.image) return;
  $('outWidth').value = Math.max(1, Math.round(state.image.width / 2));
  $('outHeight').value = Math.max(1, Math.round(state.image.height / 2));
  $('useExtent').checked = false;
  $('extentRow').hidden = true;
  doRun();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll() {
  renderSource();
  if (!state.result) {
    clearCanvas($('resultCanvas'));
    clearCanvas($('coverageCanvas'));
    $('fieldLegend').textContent = 'no result';
    $('covLegend').textContent = 'no result';
    $('summaryBox').textContent = 'No result yet.';
    $('anomalyBox').textContent = 'None.';
    $('sourceLegend').textContent = '';
    return;
  }
  readDisplaySettings();
  const disp = buildDisplay(state);
  lastDisplay = disp;
  drawLayer($('resultCanvas'), state.result.width, state.result.height, disp.field, $('showResult').checked);
  drawLayer($('coverageCanvas'), state.result.width, state.result.height, disp.coverage, $('showCoverage').checked);
  drawSourceOverlay();
  $('fieldLegend').textContent =
    `display limits ${fmt(disp.limits.min)} … ${fmt(disp.limits.max)} (${disp.limits.method}); ` +
    `${disp.limits.sampleCount} defined cells`;
  const r = state.result;
  const cov = projectedCoverage(state);
  let low = 0;
  let undef = 0;
  for (let i = 0; i < cov.length; i++) {
    if (r.defined[i] === 0) undef++;
    else if (cov[i] < state.lowCoverage) low++;
  }
  $('covLegend').textContent =
    `red < ${state.lowCoverage} coverage · ${low} low · ${undef} undefined (grey)`;
  drawZoomBoxes();
}

function renderSource() {
  const c = $('sourceCanvas');
  if (!state.image) { clearCanvas(c); return; }
  const { values, width, height } = state.image;
  const limits = computeLimitsForSource(values);
  const rgba = fieldToRgba(values, limits);
  if ($('showSourceMask').checked) {
    for (let i = 0; i < width * height; i++) {
      if (!state.mask[i]) {
        rgba[i * 4] = 255; rgba[i * 4 + 1] = 60; rgba[i * 4 + 2] = 60;
        rgba[i * 4 + 3] = Math.round(rgba[i * 4 + 3] * 0.55);
      }
    }
  }
  drawLayer(c, width, height, rgba, $('showSource').checked);
  const s = maskStats(state.mask);
  $('sourceLegend').textContent = `${width}×${height} · ${s.valid}/${s.total} usable · preview only`;
}

let sourceLimitsCache = null;
function computeLimitsForSource(values) {
  const key = values;
  if (sourceLimitsCache && sourceLimitsCache.key === key) return sourceLimitsCache.limits;
  // Robust preview limits over finite values only.
  const finite = [];
  const stride = Math.max(1, Math.floor(values.length / 200000));
  for (let i = 0; i < values.length; i += stride) if (Number.isFinite(values[i])) finite.push(values[i]);
  finite.sort((a, b) => a - b);
  let min = finite.length ? finite[0] : 0;
  let max = finite.length ? finite[finite.length - 1] : 1;
  if (!(max > min)) { const c = min; const p = Math.abs(c) > 0 ? Math.abs(c) * 1e-6 : 0.5; min = c - p; max = c + p; }
  const limits = { min, max };
  sourceLimitsCache = { key, limits };
  return limits;
}

function fieldToRgba(values, limits) {
  const n = values.length;
  const rgba = new Uint8ClampedArray(n * 4);
  const span = limits.max - limits.min;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { rgba[i * 4 + 3] = 0; continue; }
    let t = span > 0 ? (v - limits.min) / span : 0.5;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const g = Math.round(t * 255);
    rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** Shared view window in output-cell coordinates, centred on the focus point. */
function viewWindow(width, height) {
  const z = Math.max(1, view.zoom);
  const w = width / z;
  const h = height / z;
  const x0 = Math.max(0, Math.min(width - w, view.focusX * width - w / 2));
  const y0 = Math.max(0, Math.min(height - h, view.focusY * height - h / 2));
  return { x0, y0, w, h, z };
}

/**
 * Draw a layer into an image-sized backing store. When zoomed, only the shared
 * view window is sampled and stretched to fill the canvas; the CSS sizing then
 * shows individual cells as large blocks (image-rendering: pixelated). All
 * three panels use viewWindow(), so their crops stay registered.
 */
function drawLayer(canvas, w, h, rgba, visible) {
  const ctx = canvas.getContext('2d');
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  if (visible) {
    const vw = viewWindow(w, h);
    if (vw.z <= 1) {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    } else {
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, vw.x0, vw.y0, vw.w, vw.h, 0, 0, w, h);
    }
  }
  fitCanvasDisplay(canvas, w, h);
}

/**
 * Size the on-screen canvas to fill the available width while preserving the
 * aspect ratio and respecting a maximum display height. Integer scaling is
 * preferred so that individual cells stay crisp squares.
 */
function fitCanvasDisplay(canvas, w, h) {
  const wrap = canvas.parentElement;
  const availW = Math.max(64, (wrap ? wrap.clientWidth : 480) - 10);
  const maxH = 340;
  let scale = Math.min(availW / w, maxH / h);
  if (scale >= 1) scale = Math.max(1, Math.floor(scale));
  canvas.style.width = `${Math.max(1, Math.round(w * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.round(h * scale))}px`;
}

function drawSourceOverlay() {
  // Draw the output grid footprint (and any crop extent) over the source.
  const c = $('sourceCanvas');
  if (!state.image || !$('showSource').checked) return;
  const ctx = c.getContext('2d');
  const { width, height } = state.image;
  const r = state.result;
  ctx.save();
  ctx.strokeStyle = 'rgba(78,161,255,0.35)';
  ctx.lineWidth = Math.max(1, width / 400);
  const extent = r ? r.extent : [0, 0, width, height];
  ctx.strokeRect(extent[0], extent[1], extent[2] - extent[0], extent[3] - extent[1]);
  if (r) {
    ctx.strokeStyle = 'rgba(78,161,255,0.9)';
    ctx.lineWidth = Math.max(1, width / 800);
    const stepX = r.scaleX;
    const stepY = r.scaleY;
    ctx.beginPath();
    for (let x = 0; x <= r.width; x++) {
      const px = extent[0] + x * stepX;
      ctx.moveTo(px, extent[1]);
      ctx.lineTo(px, extent[3]);
    }
    for (let y = 0; y <= r.height; y++) {
      const py = extent[1] + y * stepY;
      ctx.moveTo(extent[0], py);
      ctx.lineTo(extent[2], py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawZoomBoxes() {
  // When zoomed, outline the shared view window on the source canvas so the
  // user can see which cells the two result panels are showing.
  if (!state.result || view.zoom <= 1 || !state.image) return;
  const r = state.result;
  const vw = viewWindow(r.width, r.height);
  const c = $('sourceCanvas');
  const dpr = c.width / state.image.width;
  const ctx = c.getContext('2d');
  const sx = r.extent[0] + (vw.x0 / r.width) * (r.extent[2] - r.extent[0]);
  const sy = r.extent[1] + (vw.y0 / r.height) * (r.extent[3] - r.extent[1]);
  const sw = (vw.w / r.width) * (r.extent[2] - r.extent[0]);
  const sh = (vw.h / r.height) * (r.extent[3] - r.extent[1]);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = Math.max(1, 1.5);
  ctx.strokeRect(sx * dpr, sy * dpr, sw * dpr, sh * dpr);
  ctx.restore();
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------
function onResultClick(ev) {
  if (!state.result) return;
  const canvas = ev.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const fx = (ev.clientX - rect.left) / rect.width;
  const fy = (ev.clientY - rect.top) / rect.height;  const vw = viewWindow(state.result.width, state.result.height);
  const x = Math.min(state.result.width - 1, Math.floor(vw.x0 + fx * vw.w));
  const y = Math.min(state.result.height - 1, Math.floor(vw.y0 + fy * vw.h));
  activeCell = { x, y };
  view.focusX = (x + 0.5) / state.result.width;
  view.focusY = (y + 0.5) / state.result.height;
  renderInspector();
  renderAll();
}

function renderInspector() {
  if (!activeCell || !state.result) return;
  const c = inspectCell(state, activeCell.x, activeCell.y);
  const r = state.result;
  const cov = projectedCoverage(state)[activeCell.y * r.width + activeCell.x];
  const rows = [
    ['cell', `x=${c.x}, y=${c.y}`],
    ['intensity', `<span class="mono">${fmtFull(c.intensity)}</span> <small>(${r.quantity})</small>`],
    ['defined', c.defined ? '<span class="badge ok">yes</span>' : '<span class="badge bad">no — NaN</span>'],
    ['coverage', `<span class="mono">${c.coverage.toFixed(6)}</span>`],
    ['valid weight', `<span class="mono">${fmtFull(c.validWeight)}</span> <small>source-pixel area</small>`],
    ['overlap Σ v·w', `<span class="mono">${fmtFull(c.overlapSum)}</span>`],
    ['projected coverage', `<span class="mono">${cov.toFixed(6)}</span>`],
    ['source bounds', `x ${c.sourceBounds.xMin}…${c.sourceBounds.xMax}, y ${c.sourceBounds.yMin}…${c.sourceBounds.yMax}`],
  ];
  $('inspectBox').innerHTML = `<table>${rows.map(
    ([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`,
  ).join('')}</table>`;
}

// ---------------------------------------------------------------------------
// Summary / anomalies / self-check
// ---------------------------------------------------------------------------
function renderSummary(prior) {
  const r = state.result;
  const s = r.stats;
  const rows = [
    ['quantity', `${r.quantity}`],
    ['units', r.quantityUnits],
    ['output grid', `${r.width}×${r.height} · step ${fmt(r.scaleX)}×${fmt(r.scaleY)}`],
    ['extent', `[${r.extent.map(fmt).join(', ')}]`],
    ['valid source px', `${s.validPixels} / ${s.sourcePixels}`],
    ['true zeros kept', String(s.validTrueZeros)],
    ['NaN/Inf excluded', String(s.maskedNonFinite + s.excludedNonFinite)],
    ['source mean', fmtFull(s.sourceMean)],
    ['output weighted mean', fmtFull(s.outputMean)],
    ['undefined cells', String(s.undefinedCells)],
    ['low-coverage cells', `${s.lowCoverageCells} (< ${s.lowCoverageThreshold})`],
    ['partition usable source', s.partitionsUsableSource ? 'yes' : 'no'],
  ];
  if (r.mode === 'sum') {
    rows.push(['output integral', fmtFull(s.outputIntegral)]);
    rows.push(['integral conserved', s.integralConserved ? '<span class="badge ok">yes</span>' : '<span class="badge bad">no</span>']);
  } else {
    rows.push(['integral conserved', '<span class="badge neutral">n/a — mean is not a total</span>']);
  }
  if (prior && prior.mode === r.mode) {
    const rel = (a, b) => (b !== 0 ? Math.abs(a - b) / Math.abs(b) : NaN);
    rows.push(['mean drift vs prev run', fmtFull(rel(s.outputMean, prior.stats.outputMean))]);
  }
  $('summaryBox').innerHTML = `<table>${rows.map(
    ([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`,
  ).join('')}</table>`;
}

function renderAnomalies() {
  const r = state.result;
  if (!r.anomalies.length) { $('anomalyBox').textContent = 'None.'; return; }
  $('anomalyBox').innerHTML = r.anomalies.map(
    (a) => `<div class="anomaly"><span class="tag sev-${a.severity}">${a.severity}</span>` +
      `<span class="mono">${a.code}</span><br>${escapeHtml(a.message)}</div>`,
  ).join('');
}

function runSelfCheck() {
  const r = state.result;
  if (!r) return;
  const ref = referenceResampleExact({
    values: state.image.values,
    mask: state.mask,
    width: state.image.width,
    height: state.image.height,
    outWidth: r.width,
    outHeight: r.height,
    extent: r.extent,
    mode: r.mode,
    sourcePixelArea: r.sourcePixelArea,
  });
  // Compensated results are not reproduced by the reference (by design).
  if (r.compensate) {
    $('selfCheckBox').textContent = 'Reference check skipped: compensated totals are an estimate by definition.';
    return;
  }
  const di = maxAbsDiff(r.intensity, ref.intensity);
  const dc = maxAbsDiff(r.coverage, ref.coverage);
  const ok = Number.isFinite(di) && di < 1e-9 && dc < 1e-9;
  $('selfCheckBox').innerHTML =
    `<span class="badge ${ok ? 'ok' : 'bad'}">${ok ? 'matches reference' : 'MISMATCH'}</span><br>` +
    `max |Δintensity| = <span class="mono">${di.toExponential(3)}</span><br>` +
    `max |Δcoverage| = <span class="mono">${dc.toExponential(3)}</span><br>` +
    `<small>Reference: independent scatter-overlap implementation.</small>`;
}

// ---------------------------------------------------------------------------
// Mask drawing
// ---------------------------------------------------------------------------
function canvasToSource(ev) {
  const canvas = $('sourceCanvas');
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * state.image.width;
  const y = ((ev.clientY - rect.top) / rect.height) * state.image.height;
  return { x, y };
}

function onCanvasDown(ev) {
  if (!state.image || $('maskTool').value === 'none') return;
  const p = canvasToSource(ev);
  drawState = { start: p, cur: p, tool: $('maskTool').value };
  ev.preventDefault();
}

function onWindowMove(ev) {
  if (!drawState) return;
  drawState.cur = canvasToSource(ev);
  renderSource();
  const ctx = $('sourceCanvas').getContext('2d');
  ctx.save();
  ctx.strokeStyle = '#4ea1ff';
  ctx.lineWidth = 1.5;
  const { start, cur } = drawState;
  if (drawState.tool.endsWith('Ellipse')) {
    ctx.beginPath();
    ctx.ellipse((start.x + cur.x) / 2, (start.y + cur.y) / 2,
      Math.abs(cur.x - start.x) / 2, Math.abs(cur.y - start.y) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.strokeRect(Math.min(start.x, cur.x), Math.min(start.y, cur.y),
      Math.abs(cur.x - start.x), Math.abs(cur.y - start.y));
  }
  ctx.restore();
}

function onWindowUp() {
  if (!drawState) return;
  const { start, cur, tool } = drawState;
  drawState = null;
  const x0 = Math.min(start.x, cur.x);
  const x1 = Math.max(start.x, cur.x);
  const y0 = Math.min(start.y, cur.y);
  const y1 = Math.max(start.y, cur.y);
  if (x1 - x0 < 0.5 || y1 - y0 < 0.5) { renderAll(); return; }
  const include = tool.startsWith('include');
  const ellipse = tool.endsWith('Ellipse');
  const mask = Uint8Array.from(state.mask);
  const { width, height } = state.image;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let inside;
      if (ellipse) {
        const nx = (px - cx) / rx;
        const ny = (py - cy) / ry;
        inside = nx * nx + ny * ny <= 1;
      } else {
        inside = px >= x0 && px <= x1 && py >= y0 && py <= y1;
      }
      if (inside) mask[y * width + x] = include ? 1 : 0;
    }
  }
  applyMask(mask, `drawn ${tool}`);
  renderAll();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildMetaExtra() {
  return {
    source: state.image
      ? { name: state.image.sourceName, width: state.image.width, height: state.image.height, dtype: state.image.dtype }
      : null,
    mask: { label: state.maskLabel, stats: state.image ? maskStats(state.mask) : null },
    display: { ...state.display, note: 'Display settings affect only the on-screen preview.' },
  };
}

function saveBlob(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showError(msg) {
  const box = $('errorBox');
  box.hidden = false;
  box.textContent = msg;
}
function clearError() {
  const box = $('errorBox');
  box.hidden = true;
  box.textContent = '';
}

function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  if (Math.abs(v) >= 1e4 || Math.abs(v) < 1e-3) return v.toExponential(3);
  return Number(v.toPrecision(6)).toString();
}
function fmtFull(v) {
  if (v === null || v === undefined) return '—';
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  return v.toPrecision(17);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Expose a small hook for automated UI tests without affecting normal use.
window.__resampler = {
  state,
  doRun,
  loadSelectedCase,
  renderInspector,
  inspectAt(x, y) {
    activeCell = { x, y };
    renderInspector();
    return inspectCell(state, x, y);
  },
  setCell(x, y) { activeCell = { x, y }; },
  getDisplay: () => lastDisplay,
};

// Controller entry points used by the contract UI steps. The page drives the
// same functions as every other interaction; there is no test-only numeric
// path.
window.__resamplerCore = { setImage, setMask, createState };

window.addEventListener('resize', () => {
  if (lastDisplay) renderAll();
});
