const canvas = document.getElementById('canvas');
const gridCanvas = document.getElementById('grid');
const fxCanvas = document.getElementById('fx');
const ctx = canvas.getContext('2d');
const gridCtx = gridCanvas.getContext('2d');
const fxCtx = fxCanvas.getContext('2d');
const drawHint = document.getElementById('drawHint');
const HINT_KEY = 'mn_seen_draw_hint';
const predictBtn = document.getElementById('predict');
const clearBtn = document.getElementById('clear');
const predictionEl = document.getElementById('prediction');
const probsEl = document.getElementById('probs');
const statusEl = document.getElementById('status');
const panel = document.getElementById('panel');
const panelToggle = document.getElementById('panelToggle');

let drawing = false;
let last = null;
let ortSession = null; // ONNX Runtime session if available
let useServerFallback = false;
let brushRadius = 12; // will be set on resize

function sizeSquareArea() {
  const wrap = document.getElementById('canvasWrap');
  const drawArea = document.getElementById('drawArea');
  const rect = wrap.getBoundingClientRect();
  const side = Math.floor(Math.min(rect.width, rect.height));
  drawArea.style.width = side + 'px';
  drawArea.style.height = side + 'px';
  [canvas, gridCanvas, fxCanvas].forEach(el => {
    el.style.width = side + 'px';
    el.style.height = side + 'px';
  });
}

function setupHiDPICanvas(el, context) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = el.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (el.width !== w) el.width = w;
  if (el.height !== h) el.height = h;
  context.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixel coordinates
  return { dpr, rect };
}

function drawGrid() {
  gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
  const { rect } = setupHiDPICanvas(gridCanvas, gridCtx);
  const w = rect.width, h = rect.height;
  // Outer border
  gridCtx.strokeStyle = 'rgba(255,255,255,0.25)';
  gridCtx.lineWidth = 1;
  gridCtx.strokeRect(0.5, 0.5, w - 1, h - 1);
  // 28x28 grid lines
  gridCtx.strokeStyle = 'rgba(255,255,255,0.10)';
  gridCtx.lineWidth = 1;
  const cols = 28, rows = 28;
  const dx = w / cols;
  const dy = h / rows;
  gridCtx.beginPath();
  for (let i = 1; i < cols; i++) {
    const x = Math.round(i * dx) + 0.5;
    gridCtx.moveTo(x, 0);
    gridCtx.lineTo(x, h);
  }
  for (let j = 1; j < rows; j++) {
    const y = Math.round(j * dy) + 0.5;
    gridCtx.moveTo(0, y);
    gridCtx.lineTo(w, y);
  }
  gridCtx.stroke();
  // Optional center crosshair
  gridCtx.strokeStyle = 'rgba(255,255,255,0.18)';
  gridCtx.beginPath();
  gridCtx.moveTo(w / 2 + 0.5, 0); gridCtx.lineTo(w / 2 + 0.5, h);
  gridCtx.moveTo(0, h / 2 + 0.5); gridCtx.lineTo(w, h / 2 + 0.5);
  gridCtx.stroke();
}

function resizeAll() {
  sizeSquareArea();
  const { rect } = setupHiDPICanvas(canvas, ctx);
  setupHiDPICanvas(gridCanvas, gridCtx);
  setupHiDPICanvas(fxCanvas, fxCtx);
  // Brush size relative to square side
  const side = Math.min(rect.width, rect.height);
  brushRadius = Math.max(6, side * 0.05);
  // Clear draw layer to black and redraw grid
  clearCanvas();
  drawGrid();
}

window.addEventListener('resize', resizeAll);

// --- Collapsible prediction panel logic ---
const PANEL_BREAKPOINT = 600; // px
let userCollapsePref = null; // null => not set by user yet

function setPanelCollapsed(collapsed, { viaUser = false } = {}) {
  if (!panel) return;
  if (collapsed) {
    panel.classList.add('collapsed');
    if (panelToggle) {
      panelToggle.setAttribute('aria-expanded', 'false');
      panelToggle.title = 'Expand';
      panelToggle.textContent = '▸';
      panelToggle.setAttribute('aria-label', 'Expand prediction details');
    }
  } else {
    panel.classList.remove('collapsed');
    if (panelToggle) {
      panelToggle.setAttribute('aria-expanded', 'true');
      panelToggle.title = 'Collapse';
      panelToggle.textContent = '▾';
      panelToggle.setAttribute('aria-label', 'Collapse prediction details');
    }
  }
  if (viaUser) userCollapsePref = collapsed;
}

function defaultCollapsedForViewport() {
  return window.matchMedia(`(max-width: ${PANEL_BREAKPOINT}px)`).matches;
}

function applyPanelStateForViewport() {
  if (userCollapsePref === null) {
    setPanelCollapsed(defaultCollapsedForViewport());
  }
}

if (panelToggle) {
  panelToggle.addEventListener('click', () => {
    const isCollapsed = panel.classList.contains('collapsed');
    setPanelCollapsed(!isCollapsed, { viaUser: true });
  });
}

window.addEventListener('resize', () => {
  applyPanelStateForViewport();
});

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  if (e.touches && e.touches.length) {
    return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
  }
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function stamp(x, y) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, brushRadius);
  g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, brushRadius, 0, Math.PI * 2);
  ctx.fill();
}

function startDraw(e) {
  drawing = true;
  // Hide the onboarding hint forever on first interaction
  if (drawHint && !drawHint.classList.contains('hidden')) {
    drawHint.classList.add('hidden');
    drawHint.setAttribute('aria-hidden', 'true');
    try { localStorage.setItem(HINT_KEY, '1'); } catch {}
  }
  last = getPos(e);
  stamp(last.x, last.y);
}

function draw(e) {
  if (!drawing) return;
  const pos = getPos(e);
  const dx = pos.x - last.x;
  const dy = pos.y - last.y;
  const dist = Math.hypot(dx, dy);
  const step = Math.max(1, brushRadius * 0.5);
  const steps = Math.ceil(dist / step);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = last.x + dx * t;
    const y = last.y + dy * t;
    stamp(x, y);
  }
  last = pos;
}

function endDraw() { drawing = false; }

canvas.addEventListener('mousedown', startDraw);
canvas.addEventListener('mousemove', draw);
window.addEventListener('mouseup', endDraw);

canvas.addEventListener('touchstart', (e) => { e.preventDefault(); startDraw(e); }, { passive: false });
canvas.addEventListener('touchmove', (e) => { e.preventDefault(); draw(e); }, { passive: false });
canvas.addEventListener('touchend', (e) => { e.preventDefault(); endDraw(e); }, { passive: false });

function clearCanvas() {
  // clear draw layer
  ctx.setTransform(1, 0, 0, 1, 0, 0); // reset to clear in device pixels
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // restore transform
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // fill black background
  ctx.fillStyle = '#000';
  const rect = canvas.getBoundingClientRect();
  ctx.fillRect(0, 0, rect.width, rect.height);
  // clear FX overlay too
  fxCtx.setTransform(1, 0, 0, 1, 0, 0);
  fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  const dpr2 = Math.max(1, window.devicePixelRatio || 1);
  fxCtx.setTransform(dpr2, 0, 0, dpr2, 0, 0);
  fxCanvas.style.opacity = '0';
}

clearBtn.addEventListener('click', () => {
  clearCanvas();
  drawGrid();
  predictionEl.textContent = '–';
  probsEl.textContent = '[ ]';
  statusEl.textContent = 'Cleared';
});

function softmax(arr) {
  const max = Math.max(...arr);
  const exps = arr.map(v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(v => v / sum);
}

function preprocessTo28x28() {
  // Full preprocessing pipeline to produce: Float32Array [1,1,28,28] normalized to [0,1]
  // and a 28x28 preview canvas for visualization.
  // 1) Grab a rasterized copy of the current drawing canvas at CSS pixel resolution
  const rect = canvas.getBoundingClientRect();
  const src = document.createElement('canvas');
  src.width = Math.max(1, Math.round(rect.width));
  src.height = Math.max(1, Math.round(rect.height));
  const sctx = src.getContext('2d');
  sctx.drawImage(canvas, 0, 0, src.width, src.height);
  const { width: W, height: H } = src;
  const rgba = sctx.getImageData(0, 0, W, H).data;

  // 2) Convert to grayscale and check inversion (ensure white digit on black background)
  const gray = new Float32Array(W * H);
  let brightCount = 0;
  for (let i = 0; i < W * H; i++) {
    const r = rgba[i * 4 + 0];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b; // 0..255
    gray[i] = y;
    if (y > 127) brightCount++;
  }
  const brightFrac = brightCount / (W * H);
  const inv = brightFrac > 0.5; // if mostly bright, assume white background => invert
  if (inv) {
    for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i];
  }

  // 3) Find bounding box around drawn pixels using threshold
  const th = 20; // tolerance for non-background
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = gray[y * W + x];
      if (v > th) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    // Empty drawing
    const data = new Float32Array(1 * 1 * 28 * 28); // all zeros
    const preview = document.createElement('canvas');
    preview.width = 28; preview.height = 28;
    const pctx = preview.getContext('2d');
    const id = pctx.createImageData(28, 28);
    // already zero
    pctx.putImageData(id, 0, 0);
    return { data, preview };
  }

  // 4) Crop to bounding box
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const crop = new Float32Array(cropW * cropH);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      crop[y * cropW + x] = gray[(minY + y) * W + (minX + x)];
    }
  }

  // 5) Resize so the longest side fits ~20 pixels (bilinear via canvas)
  const scale = 20 / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  const smallC = document.createElement('canvas');
  smallC.width = newW; smallC.height = newH;
  const smallCtx = smallC.getContext('2d');
  const srcCropC = document.createElement('canvas');
  srcCropC.width = cropW; srcCropC.height = cropH;
  const scctx = srcCropC.getContext('2d');
  // paint crop into srcCropC
  const cropImageData = scctx.createImageData(cropW, cropH);
  for (let i = 0; i < cropW * cropH; i++) {
    const v = Math.max(0, Math.min(255, Math.round(crop[i])));
    cropImageData.data[i * 4 + 0] = v;
    cropImageData.data[i * 4 + 1] = v;
    cropImageData.data[i * 4 + 2] = v;
    cropImageData.data[i * 4 + 3] = 255;
  }
  scctx.putImageData(cropImageData, 0, 0);
  smallCtx.drawImage(srcCropC, 0, 0, newW, newH);
  const smallData = smallCtx.getImageData(0, 0, newW, newH).data;

  // 6) Pad to 28x28 centered
  let canvas28 = new Float32Array(28 * 28);
  const top = Math.floor((28 - newH) / 2);
  const left = Math.floor((28 - newW) / 2);
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const v = smallData[(y * newW + x) * 4]; // R channel (grayscale)
      canvas28[(top + y) * 28 + (left + x)] = v;
    }
  }

  // 7) Center by center of mass (integer shift)
  let mass = 0, mX = 0, mY = 0;
  for (let y = 0; y < 28; y++) {
    for (let x = 0; x < 28; x++) {
      const v = canvas28[y * 28 + x];
      mass += v;
      mX += v * x;
      mY += v * y;
    }
  }
  if (mass > 1e-6) {
    const cx = mX / mass;
    const cy = mY / mass;
    const dx = Math.round(13.5 - cx);
    const dy = Math.round(13.5 - cy);
    if (dx !== 0 || dy !== 0) {
      const shifted = new Float32Array(28 * 28);
      for (let y = 0; y < 28; y++) {
        for (let x = 0; x < 28; x++) {
          const sx = x - dx;
          const sy = y - dy;
          if (sx >= 0 && sx < 28 && sy >= 0 && sy < 28) {
            shifted[y * 28 + x] = canvas28[sy * 28 + sx];
          }
        }
      }
      canvas28 = shifted;
    }
  }

  // 8) Normalize to [0,1] and build preview
  const data = new Float32Array(1 * 1 * 28 * 28);
  const preview = document.createElement('canvas');
  preview.width = 28; preview.height = 28;
  const pctx = preview.getContext('2d');
  const id = pctx.createImageData(28, 28);
  for (let i = 0; i < 28 * 28; i++) {
    const g = Math.max(0, Math.min(255, Math.round(canvas28[i])));
    id.data[i * 4 + 0] = g;
    id.data[i * 4 + 1] = g;
    id.data[i * 4 + 2] = g;
    id.data[i * 4 + 3] = 255;
    data[i] = g / 255.0; // [0,1]
  }
  pctx.putImageData(id, 0, 0);
  return { data, preview };
}

function showPixelationOverlay(preview28) {
  // Show the exact 28x28 preprocessed image (pixelated to full size).
  let src = preview28;
  if (!src) {
    // If not provided, compute locally.
    const { preview } = preprocessTo28x28();
    src = preview;
  }
  const rect = fxCanvas.getBoundingClientRect();
  fxCtx.imageSmoothingEnabled = false;
  fxCtx.clearRect(0, 0, rect.width, rect.height);
  fxCtx.drawImage(src, 0, 0, 28, 28, 0, 0, rect.width, rect.height);
  fxCanvas.style.opacity = '1';
  // Fade out after a brief moment
  setTimeout(() => {
    fxCanvas.style.opacity = '0';
    setTimeout(() => {
      fxCtx.clearRect(0, 0, rect.width, rect.height);
    }, 300);
  }, 900);
}

async function tryInitOnnx() {
  if (typeof ort === 'undefined') return false;

  // Helper to detect text/HTML/LFS instead of a real ONNX binary
  function looksLikeTextOrHtml(buf, contentType) {
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('text') || ct.includes('html') || ct.includes('xml')) return true;
    const bytes = new Uint8Array(buf.slice(0, Math.min(buf.byteLength, 256)));
    let ascii = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) ascii++;
    }
    const ratio = ascii / Math.max(1, bytes.length);
    const head = new TextDecoder().decode(bytes);
    if (/^\s*<!doctype html/i.test(head) || /^\s*<html/i.test(head)) return true;
    if (/^version\s+https?:\/\/git-lfs/i.test(head)) return true;
    // Consider it text if majority printable
    return ratio > 0.8;
  }

  async function fetchModelBytesWithFallbacks() {
    const tried = [];

    // 1) Primary: relative to the current page (supports subpaths)
    const primary = new URL('mnist_cnn.onnx', window.location.href).toString();
    const urls = [primary];

    // 2) If on GitHub Pages, add jsDelivr fallbacks from repo
    const host = window.location.hostname;
    if (host.endsWith('github.io')) {
      // owner.github.io/repo[/...]
      const pathParts = window.location.pathname.split('/').filter(Boolean);
      const owner = host.split('.')[0];
      const repo = pathParts.length > 0 ? pathParts[0] : '';
      if (owner && repo) {
        const branches = ['gh-pages', 'main', 'master'];
        for (const br of branches) {
          urls.push(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${br}/mnist_cnn.onnx`);
        }
      }
    }

    let lastErr = null;
    for (const url of urls) {
      try {
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const ct = resp.headers.get('content-type') || '';
        if (looksLikeTextOrHtml(buf, ct)) {
          const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 256)));
          throw new Error(`Model URL returned text/HTML instead of binary. First bytes: ${head.substring(0, 80)}...`);
        }
        return { buf, url };
      } catch (e) {
        tried.push(`${url} → ${e.message}`);
        lastErr = e;
      }
    }
    const details = tried.join('\n');
    throw new Error(`Unable to fetch a valid ONNX model. Tried URLs:\n${details}`);
  }

  try {
    // Configure ONNX Runtime Web for static hosting without COOP/COEP
    const coi = Boolean(window.crossOriginIsolated);
    ort.env.wasm.numThreads = 1; // avoid SAB requirement on static hosts
    ort.env.wasm.simd = coi;     // use SIMD only when COI-enabled

    const { buf, url: usedUrl } = await fetchModelBytesWithFallbacks();

    ortSession = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    useServerFallback = false;
    statusEl.textContent = 'ONNX Runtime (WebAssembly) ready';
    return true;
  } catch (e) {
    console.warn('ONNX init failed:', e);
    statusEl.textContent = 'Failed to initialize ONNX in browser: ' + (e && e.message ? e.message : e);
    useServerFallback = false;
    return false;
  }
}

async function predictLocal() {
  const { data, preview } = preprocessTo28x28();
  const tensor = new ort.Tensor('float32', data, [1, 1, 28, 28]);
  const outputs = await ortSession.run({ input: tensor }).catch(async () => {
    // Some exported models may use a different input name
    // Try common alternatives
    return await ortSession.run({ x: tensor }).catch(() => ortSession.run({ images: tensor }));
  });
  const first = outputs[Object.keys(outputs)[0]]; // take first output
  const logits = Array.from(first.data);
  const probs = softmax(logits);
  let pred = 0, best = -Infinity;
  for (let i = 0; i < probs.length; i++) if (probs[i] > best) { best = probs[i]; pred = i; }
  return { prediction: pred, probs, preview };
}


predictBtn.addEventListener('click', async () => {
  try {
    if (!ortSession) {
      statusEl.textContent = 'Initializing ONNX…';
      const ok = await tryInitOnnx();
      if (!ok || !ortSession) throw new Error('ONNX not initialized');
    }
    statusEl.textContent = 'Predicting in browser…';
    const out = await predictLocal();
    const preview = out.preview;
    predictionEl.textContent = String(out.prediction);
    probsEl.textContent = JSON.stringify(out.probs, null, 2);
    statusEl.textContent = 'Done';
    showPixelationOverlay(preview);
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    // Still show the local preprocessed view to aid debugging
    const { preview } = preprocessTo28x28();
    showPixelationOverlay(preview);
  }
});

function initDrawHint() {
  if (!drawHint) return;
  let seen = false;
  try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch {}
  if (seen) {
    drawHint.classList.add('hidden');
    drawHint.setAttribute('aria-hidden', 'true');
  } else {
    drawHint.classList.remove('hidden');
    drawHint.setAttribute('aria-hidden', 'false');
  }
}

(async function main() {
  resizeAll();
  applyPanelStateForViewport();
  initDrawHint();
  await tryInitOnnx();
})();
