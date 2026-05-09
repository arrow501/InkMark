'use strict';

/* =====================================================================
 * Constants & state
 * ===================================================================*/

const DEMO = `# InkMark

Markdown notes you can ink directly over. Headings anchor your strokes — when you edit prose, ink rides along.

## How it works

Switch to **Ink** mode in the toolbar. Draw on the page. Switch back to **Write** mode to edit.

The **Source** mode shows your markdown the way an editor would: monospace, line numbers, every \`#\` and \`*\` visible.

## Try it

Draw something in this section. Then go to Write mode, add a paragraph above. Switch back. Your ink stays anchored here.

## Markdown features

You get GFM out of the box:

- task lists with \`- [ ]\` and \`- [x]\`
- tables, fenced code, footnotes
- inline \`code\` and **emphasis**

\`\`\`js
function hello() {
  return "world";
}
\`\`\`

\`\`\`ink
{"v":1,"strokes":[]}
\`\`\`
`;

const STORAGE_KEY = 'inkmark.autosave.v1';
const STORAGE_THEME = 'inkmark.theme';

const $ = (id) => document.getElementById(id);
const ta = $('textarea');
const sourceTa = $('source-textarea');
const lineGutter = $('line-gutter');
const docContent = $('doc-content');
const overlay = $('ink-overlay');
const toc = $('toc');

const state = {
  mode: 'write',
  theme:
    localStorage.getItem(STORAGE_THEME) ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  strokes: [],
  orphans: [],
  dirty: false,
  drawing: null,
  installPrompt: null,
};

/* =====================================================================
 * Markdown setup (marked + DOMPurify, GFM enabled)
 * ===================================================================*/

if (window.marked) {
  marked.use({ gfm: true, breaks: false, pedantic: false });
}

function sanitize(html) {
  if (!window.DOMPurify) return html;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'id'],
  });
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).padStart(4, '0').slice(0, 4);
}
function slugify(s) {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'h'
  );
}
function headingId(text) {
  return `h-${slugify(text)}-${hash(text)}`;
}

function renderMarkdown(body) {
  const html = marked.parse(body);
  const tmp = document.createElement('div');
  tmp.innerHTML = sanitize(html);
  tmp.querySelectorAll('h1, h2, h3, h4').forEach((h) => {
    if (!h.id) h.id = headingId(h.textContent || '');
  });
  tmp.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  return tmp.innerHTML;
}

/* =====================================================================
 * Source ↔ ink JSON
 * ===================================================================*/

const INK_RE = /\n?```ink\s*\n([\s\S]*?)\n```\s*$/;

function parseSource(src) {
  const normalized = String(src || '').replace(/\r\n?/g, '\n');
  const m = normalized.match(INK_RE);
  let body = normalized;
  let ink = { v: 1, strokes: [] };
  if (m) {
    body = normalized.slice(0, m.index);
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && Array.isArray(parsed.strokes)) ink = parsed;
    } catch (e) {
      showToast('Ink block JSON is malformed — strokes hidden until fixed');
    }
  }
  return { body, ink };
}

function buildSource(body, strokes) {
  const json = JSON.stringify({ v: 1, strokes });
  const trimmed = body.replace(/\s*$/, '');
  return `${trimmed}\n\n\`\`\`ink\n${json}\n\`\`\`\n`;
}

function syncInkToSource() {
  const src = getSource();
  const { body } = parseSource(src);
  setSource(buildSource(body, [...state.strokes, ...state.orphans]), { silent: true });
}

function getSource() {
  return state.mode === 'source' ? sourceTa.value : ta.value;
}
function setSource(text, { silent = false } = {}) {
  ta.value = text;
  sourceTa.value = text;
  if (!silent) markDirty();
  updateLineGutter();
  updateTOC();
}

/* =====================================================================
 * Geometry: RDP, decimation, anchoring
 * ===================================================================*/

function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  let maxD = 0,
    idx = 0;
  const a = points[0],
    b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps) {
    const left = rdp(points.slice(0, idx + 1), eps);
    const right = rdp(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}
function perpDist(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const px = a.x + t * dx,
    py = a.y + t * dy;
  return Math.hypot(p.x - px, p.y - py);
}

function shouldRecord(p, last, prev) {
  if (!last) return true;
  const d = Math.hypot(p.x - last.x, p.y - last.y);
  if (d > 12) return true;
  if (Math.abs((p.pressure ?? 0.5) - (last.pressure ?? 0.5)) > 0.1) return true;
  if (prev) {
    const a1 = Math.atan2(last.y - prev.y, last.x - prev.x);
    const a2 = Math.atan2(p.y - last.y, p.x - last.x);
    let dA = a2 - a1;
    while (dA > Math.PI) dA -= 2 * Math.PI;
    while (dA < -Math.PI) dA += 2 * Math.PI;
    if (Math.abs(dA) > 0.15) return true;
  }
  return false;
}

function findAnchor(yPage) {
  const headings = [...docContent.querySelectorAll('h1, h2')];
  const docTop = docContent.getBoundingClientRect().top;
  let best = null;
  for (const h of headings) {
    const top = h.getBoundingClientRect().top - docTop;
    if (top <= yPage) best = { el: h, top };
    else break;
  }
  if (!best) return null;
  return {
    heading: best.el.textContent.trim(),
    id: best.el.id,
    headingTop: best.top,
    offsetY: yPage - best.top,
  };
}

function finalizeStroke(rawPoints, pointerType) {
  if (rawPoints.length < 2) return null;
  const simple = rdp(rawPoints, 0.8);
  if (simple.length < 2) return null;

  let cy = 0;
  for (const p of simple) cy += p.y;
  cy /= simple.length;

  const anchor = findAnchor(cy);
  if (!anchor) return null;

  const colWidth = docContent.clientWidth;
  const points = simple.map((p, i) => {
    const x = p.x / colWidth;
    const y = p.y - anchor.headingTop;
    let vx = 0,
      vy = 0;
    if (i < simple.length - 1) {
      const n = simple[i + 1];
      vx = (n.x - p.x) / colWidth;
      vy = n.y - p.y;
    }
    return [
      +x.toFixed(4),
      Math.round(y),
      +vx.toFixed(4),
      Math.round(vy),
      +(p.pressure ?? 0.5).toFixed(2),
    ];
  });

  return {
    anchor: {
      heading: anchor.heading,
      id: anchor.id,
      offsetY: Math.round(anchor.offsetY),
    },
    size: 3,
    pen: pointerType === 'pen',
    points,
  };
}

/* =====================================================================
 * Stroke rendering
 * ===================================================================*/

function strokeToPath(stroke) {
  if (!stroke || !stroke.length) return '';
  const out = [`M ${stroke[0][0].toFixed(2)} ${stroke[0][1].toFixed(2)}`];
  for (let i = 1; i < stroke.length; i++) {
    out.push(`L ${stroke[i][0].toFixed(2)} ${stroke[i][1].toFixed(2)}`);
  }
  out.push('Z');
  return out.join(' ');
}

function renderStrokes() {
  overlay.innerHTML = '';
  const w = docContent.clientWidth;
  const h = Math.max(docContent.scrollHeight, docContent.offsetHeight);
  overlay.setAttribute('width', w);
  overlay.setAttribute('height', h);
  overlay.style.width = w + 'px';
  overlay.style.height = h + 'px';
  overlay.style.left = docContent.offsetLeft + 'px';
  overlay.style.top = docContent.offsetTop + 'px';

  const inkColor = getComputedStyle(document.body).getPropertyValue('--ink').trim() || '#141413';
  const docTop = docContent.getBoundingClientRect().top;
  const stillAnchored = [];
  const newOrphans = [];

  for (const s of [...state.strokes, ...state.orphans]) {
    let hEl = document.getElementById(s.anchor.id);
    if (!hEl) {
      const fuzzy = [...docContent.querySelectorAll('h1, h2')].find(
        (el) => el.textContent.trim() === s.anchor.heading.trim()
      );
      if (fuzzy) {
        hEl = fuzzy;
        s.anchor.id = fuzzy.id;
      }
    }
    if (!hEl) {
      newOrphans.push(s);
      continue;
    }
    stillAnchored.push(s);

    const hTop = hEl.getBoundingClientRect().top - docTop;
    const abs = s.points.map(([x, y, , , p]) => ({
      x: x * w,
      y: hTop + y,
      pressure: p,
    }));

    const stroke = window.getStroke
      ? window.getStroke(abs, {
          size: 3.2,
          thinning: 0.5,
          smoothing: 0.6,
          streamline: 0.5,
          simulatePressure: !s.pen,
          last: true,
        })
      : null;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (stroke && stroke.length) {
      path.setAttribute('d', strokeToPath(stroke));
      path.setAttribute('fill', inkColor);
    } else {
      path.setAttribute('d', 'M ' + abs.map((p) => `${p.x},${p.y}`).join(' L '));
      path.setAttribute('stroke', inkColor);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    }
    overlay.appendChild(path);
  }

  state.strokes = stillAnchored;
  state.orphans = newOrphans;
  updateOrphanTray();
  updateInkCounter();
}

/* =====================================================================
 * Drawing
 * ===================================================================*/

let liveRaw = [];
let recordedRaw = [];
let livePath = null;

function startStroke(e) {
  if (state.mode !== 'ink') return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  overlay.setPointerCapture(e.pointerId);
  state.drawing = { pointerId: e.pointerId, pointerType: e.pointerType };
  const p = { x: e.offsetX, y: e.offsetY, pressure: e.pressure || 0.5 };
  liveRaw = [p];
  recordedRaw = [p];
  livePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  livePath.setAttribute('fill', getComputedStyle(document.body).getPropertyValue('--ink').trim());
  overlay.appendChild(livePath);
  drawLive();
}

function moveStroke(e) {
  if (!state.drawing || e.pointerId !== state.drawing.pointerId) return;
  e.preventDefault();
  const p = { x: e.offsetX, y: e.offsetY, pressure: e.pressure || 0.5 };
  liveRaw.push(p);
  const last = recordedRaw[recordedRaw.length - 1];
  const prev = recordedRaw[recordedRaw.length - 2];
  if (shouldRecord(p, last, prev)) recordedRaw.push(p);
  drawLive();
}

function drawLive() {
  if (!livePath || !window.getStroke) return;
  const stroke = window.getStroke(liveRaw, {
    size: 3.2,
    thinning: 0.5,
    smoothing: 0.6,
    streamline: 0.5,
    simulatePressure: state.drawing?.pointerType !== 'pen',
  });
  livePath.setAttribute('d', strokeToPath(stroke));
}

function endStroke(e) {
  if (!state.drawing || e.pointerId !== state.drawing.pointerId) return;
  e.preventDefault();
  const last = { x: e.offsetX, y: e.offsetY, pressure: e.pressure || 0.5 };
  if (recordedRaw[recordedRaw.length - 1] !== last) recordedRaw.push(last);
  const stroke = finalizeStroke(recordedRaw, state.drawing.pointerType);
  state.drawing = null;
  liveRaw = [];
  recordedRaw = [];
  if (livePath) {
    livePath.remove();
    livePath = null;
  }
  if (stroke) {
    state.strokes.push(stroke);
    markDirty();
    syncInkToSource();
  }
  renderStrokes();
}

function undo() {
  if (!state.strokes.length) return;
  state.strokes.pop();
  markDirty();
  syncInkToSource();
  renderStrokes();
}

/* =====================================================================
 * Mode switching
 * ===================================================================*/

async function setMode(mode) {
  if (mode === state.mode) return;
  // mirror text between editors before switching
  if (state.mode === 'source') ta.value = sourceTa.value;
  else sourceTa.value = ta.value;

  state.mode = mode;
  document.body.dataset.mode = mode;
  $('btn-write').classList.toggle('active', mode === 'write');
  $('btn-source').classList.toggle('active', mode === 'source');
  $('btn-ink').classList.toggle('active', mode === 'ink');
  toggleHidden($('ink-tools'), mode !== 'ink');
  toggleHidden($('write-tools'), mode === 'ink');

  if (mode === 'write') {
    overlay.innerHTML = '';
    updateOrphanTray();
    setTimeout(() => ta.focus(), 0);
  } else if (mode === 'source') {
    overlay.innerHTML = '';
    updateOrphanTray();
    updateLineGutter();
    setTimeout(() => sourceTa.focus(), 0);
  } else {
    const { body, ink } = parseSource(getSource());
    state.strokes = (ink.strokes || []).filter((s) => s.anchor && Array.isArray(s.points));
    state.orphans = [];
    docContent.innerHTML = renderMarkdown(body);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(r));
    renderStrokes();
  }
  updateTOC();
}

function toggleHidden(el, hidden) {
  if (hidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

/* =====================================================================
 * Theme
 * ===================================================================*/

const SUN_PATH =
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>';
const MOON_PATH = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';

function setTheme(t) {
  state.theme = t;
  document.documentElement.dataset.theme = t;
  localStorage.setItem(STORAGE_THEME, t);
  $('theme-icon').innerHTML = t === 'dark' ? SUN_PATH : MOON_PATH;
  $('btn-theme').setAttribute('title', t === 'dark' ? 'Switch to light' : 'Switch to dark');
  if (state.mode === 'ink') renderStrokes();
}

/* =====================================================================
 * UI updates
 * ===================================================================*/

function updateInkCounter() {
  const n = state.strokes.length;
  $('ink-counter').textContent = `${n} stroke${n === 1 ? '' : 's'}`;
}

function updateOrphanTray() {
  const tray = $('orphan-tray');
  if (state.orphans.length && state.mode === 'ink') {
    const n = state.orphans.length;
    tray.innerHTML = `<span>${n} orphaned stroke${n === 1 ? '' : 's'}</span><button id="orphan-clear">Discard</button>`;
    tray.classList.add('visible');
    $('orphan-clear').onclick = () => {
      state.orphans = [];
      markDirty();
      syncInkToSource();
      renderStrokes();
    };
  } else {
    tray.classList.remove('visible');
  }
}

function updateLineGutter() {
  if (state.mode !== 'source') return;
  const lines = (sourceTa.value.match(/\n/g) || []).length + 1;
  let s = '';
  for (let i = 1; i <= lines; i++) s += i + '\n';
  lineGutter.textContent = s;
}

function updateTOC() {
  const src = getSource();
  const { body } = parseSource(src);
  const lines = body.split('\n');
  const items = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const m = line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
    if (m) items.push({ level: m[1].length, text: m[2], line: i });
  });
  if (!items.length) {
    toc.innerHTML = '<div class="toc-empty">No headings yet</div>';
    return;
  }
  toc.innerHTML = items
    .map(
      (it) =>
        `<button class="toc-item h${it.level}" data-line="${it.line}" data-text="${escapeAttr(it.text)}">${escapeHtml(it.text)}</button>`
    )
    .join('');
  toc.querySelectorAll('.toc-item').forEach((el) => {
    el.addEventListener('click', () => {
      jumpToHeading(parseInt(el.dataset.line, 10), el.dataset.text);
      if (matchMedia('(max-width: 900px)').matches) closeSidebar();
    });
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return s.replace(/"/g, '&quot;');
}

function jumpToHeading(lineIdx, text) {
  if (state.mode === 'ink') {
    const id = headingId(text);
    const el =
      document.getElementById(id) ||
      [...docContent.querySelectorAll('h1,h2')].find((h) => h.textContent.trim() === text.trim());
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const target = state.mode === 'source' ? sourceTa : ta;
  const lines = target.value.split('\n');
  let pos = 0;
  for (let i = 0; i < lineIdx && i < lines.length; i++) pos += lines[i].length + 1;
  target.focus();
  target.setSelectionRange(pos, pos + (lines[lineIdx] ? lines[lineIdx].length : 0));
  // approximate scroll into view
  const ratio = pos / Math.max(target.value.length, 1);
  window.scrollTo({
    top: target.offsetTop + target.offsetHeight * ratio - 80,
    behavior: 'smooth',
  });
}

/* =====================================================================
 * Toast & modal
 * ===================================================================*/

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(showToast._tid);
  showToast._tid = setTimeout(() => {
    t.style.display = 'none';
  }, 3500);
}

function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const modal = $('modal');
    $('modal-title').textContent = title;
    $('modal-message').textContent = message;
    const ok = $('modal-confirm');
    const cancel = $('modal-cancel');
    ok.textContent = confirmLabel;
    ok.classList.toggle('danger', !!danger);
    ok.classList.toggle('primary', !danger);
    modal.classList.add('open');
    const cleanup = (val) => {
      modal.classList.remove('open');
      ok.onclick = cancel.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') cleanup(true);
    };
    ok.onclick = () => cleanup(true);
    cancel.onclick = () => cleanup(false);
    document.addEventListener('keydown', onKey);
  });
}

/* =====================================================================
 * Save / Load / Autosave
 * ===================================================================*/

function markDirty() {
  state.dirty = true;
  $('save-dot').classList.remove('hidden');
  scheduleAutosave();
}
function markClean() {
  state.dirty = false;
  $('save-dot').classList.add('hidden');
}

let autosaveT;
function scheduleAutosave() {
  clearTimeout(autosaveT);
  autosaveT = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, getSource());
    } catch (e) {
      /* quota */
    }
  }, 600);
}
function loadAutosave() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && v.trim() ? v : null;
  } catch (e) {
    return null;
  }
}
function clearAutosave() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {}
}

function suggestFilename() {
  const { body } = parseSource(getSource());
  const m = body.match(/^#\s+(.+)$/m);
  const title = m ? m[1].trim() : 'inkmark';
  return slugify(title).slice(0, 60) + '.md';
}

function saveFile() {
  syncInkToSource();
  const src = getSource();
  const blob = new Blob([src], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  markClean();
  clearAutosave();
}

async function maybeWarnBeforeReplacing() {
  if (!state.dirty) return true;
  return confirmDialog({
    title: 'Unsaved changes',
    message: 'You have unsaved edits. Continue and discard them?',
    confirmLabel: 'Discard & continue',
    danger: true,
  });
}

async function reRenderForLoadedSource() {
  if (state.mode === 'ink') {
    state.mode = 'write';
    await setMode('ink');
  } else {
    updateLineGutter();
    updateTOC();
  }
}

async function loadFile(file) {
  if (!(await maybeWarnBeforeReplacing())) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const text = String(reader.result || '').replace(/\r\n?/g, '\n');
    setSource(text, { silent: true });
    markClean();
    clearAutosave();
    await reRenderForLoadedSource();
    showToast('Loaded ' + (file.name || 'file'));
  };
  reader.onerror = () => showToast('Could not read file');
  reader.readAsText(file);
}

async function newDocument() {
  if (!(await maybeWarnBeforeReplacing())) return;
  setSource(DEMO, { silent: true });
  markClean();
  clearAutosave();
  await reRenderForLoadedSource();
}

/* =====================================================================
 * Editing helpers
 * ===================================================================*/

function insertSection() {
  const target = state.mode === 'source' ? sourceTa : ta;
  const pos = target.selectionStart;
  const before = target.value.slice(0, pos);
  const after = target.value.slice(pos);
  const lead =
    before.length === 0 || before.endsWith('\n\n')
      ? ''
      : before.endsWith('\n')
        ? '\n'
        : '\n\n';
  const insert = `${lead}## New section\n\n`;
  target.value = before + insert + after;
  const caret = before.length + lead.length + 3;
  target.setSelectionRange(caret, caret + 'New section'.length);
  target.focus();
  if (state.mode === 'source') ta.value = target.value;
  else sourceTa.value = target.value;
  markDirty();
  updateLineGutter();
  updateTOC();
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
}
function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}

/* =====================================================================
 * PWA: SW + install + file_handlers / launchQueue
 * ===================================================================*/

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function bindInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('btn-install').hidden = false;
  });
  $('btn-install').addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    $('btn-install').hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    $('btn-install').hidden = true;
    showToast('InkMark installed');
  });
}

async function handleLaunchQueue() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    if (!(await maybeWarnBeforeReplacing())) return;
    for (const handle of params.files) {
      try {
        const file = await handle.getFile();
        const text = (await file.text()).replace(/\r\n?/g, '\n');
        setSource(text, { silent: true });
        markClean();
        clearAutosave();
        await reRenderForLoadedSource();
        showToast('Opened ' + file.name);
        break;
      } catch (e) {
        /* ignore */
      }
    }
  });
}

/* =====================================================================
 * Init
 * ===================================================================*/

function init() {
  setTheme(state.theme);
  document.body.dataset.mode = 'write';

  const url = new URL(location.href);
  const wantsNew = url.searchParams.get('new') === '1';
  const restored = !wantsNew && loadAutosave();
  if (restored) {
    setSource(restored, { silent: true });
    showToast('Restored from autosave');
  } else {
    setSource(DEMO, { silent: true });
    clearAutosave();
  }
  markClean();
  updateTOC();
  updateLineGutter();

  ta.addEventListener('input', () => {
    sourceTa.value = ta.value;
    markDirty();
    updateTOC();
  });
  sourceTa.addEventListener('input', () => {
    ta.value = sourceTa.value;
    markDirty();
    updateLineGutter();
    updateTOC();
  });
  sourceTa.addEventListener('scroll', () => {
    lineGutter.scrollTop = sourceTa.scrollTop;
  });

  $('btn-write').onclick = () => setMode('write');
  $('btn-source').onclick = () => setMode('source');
  $('btn-ink').onclick = () => setMode('ink');
  $('btn-theme').onclick = () => setTheme(state.theme === 'dark' ? 'light' : 'dark');
  $('btn-save').onclick = saveFile;
  $('btn-load').onclick = () => $('file-input').click();
  $('file-input').onchange = (e) => {
    const f = e.target.files[0];
    if (f) loadFile(f);
    e.target.value = '';
  };
  $('btn-undo').onclick = undo;
  $('btn-insert-section').onclick = insertSection;
  $('btn-new').onclick = newDocument;
  $('brand-home').onclick = (e) => {
    e.preventDefault();
    newDocument();
  };

  $('mobile-menu-btn').onclick = openSidebar;
  $('sidebar-scrim').onclick = closeSidebar;

  overlay.addEventListener('pointerdown', startStroke);
  overlay.addEventListener('pointermove', moveStroke);
  overlay.addEventListener('pointerup', endStroke);
  overlay.addEventListener('pointercancel', endStroke);
  overlay.addEventListener('lostpointercapture', endStroke);

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') {
      e.preventDefault();
      saveFile();
    } else if (mod && k === 'o') {
      e.preventDefault();
      $('file-input').click();
    } else if (mod && k === 'e') {
      e.preventDefault();
      const order = ['write', 'source', 'ink'];
      const next = order[(order.indexOf(state.mode) + 1) % order.length];
      setMode(next);
    } else if (mod && k === 'z' && state.mode === 'ink' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (mod && e.shiftKey && k === 'n') {
      e.preventDefault();
      newDocument();
    } else if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
      closeSidebar();
    }
  });

  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (state.mode === 'ink') renderStrokes();
    }, 100);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  registerSW();
  bindInstallPrompt();
  handleLaunchQueue();
}

if (window.getStroke) init();
else window.addEventListener('inkmark:ready', init, { once: true });
