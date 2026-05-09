'use strict';

/* =====================================================================
 * Constants & state
 * ===================================================================*/

const DEMO = `# InkMark

Markdown notes you can ink directly over. Headings anchor your strokes — when you edit prose, ink rides along.

## How it works

Switch to **Ink** mode in the toolbar. Draw on the page. Switch back to **Write** mode to edit. Click any block to edit its source — the rest of the page stays rendered.

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

const BLANK_DOC = `# Untitled

Start writing.

\`\`\`ink
{"v":1,"strokes":[]}
\`\`\`
`;

const STORAGE_KEY = 'inkmark.autosave.v1';
const STORAGE_THEME = 'inkmark.theme';
const STORAGE_SIDEBAR = 'inkmark.sidebar.hidden';

const $ = (id) => document.getElementById(id);

const writeEditor = $('write-editor');
const sourceTa = $('source-textarea');
const sourceHighlight = $('source-highlight');
const lineGutter = $('line-gutter');
const docContent = $('doc-content');
const overlay = $('ink-overlay');
const toc = $('toc');

const state = {
  mode: 'write',
  theme:
    localStorage.getItem(STORAGE_THEME) ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  body: '',           // canonical markdown body (no ink fence)
  blocks: [],         // for write mode editing — derived from body
  activeIdx: null,    // index of active (source) block in write mode
  strokes: [],
  orphans: [],
  dirty: false,
  drawing: null,
  installPrompt: null,
};

/* =====================================================================
 * Markdown setup
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
    s.toLowerCase().trim()
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

function renderBlockHTML(src) {
  if (!src.trim()) return '<div class="block-empty"></div>';
  const html = marked.parse(src);
  return sanitize(html);
}

/* =====================================================================
 * Markdown syntax highlighter for Source mode (color-only so the
 * highlighted overlay aligns character-for-character with the textarea)
 * ===================================================================*/

function escHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function highlightInline(text) {
  return text
    .replace(/(\\[\\`*_{}\[\]()#+\-.!>])/g, '<span class="md-mark">$1</span>')
    .replace(/(`+)([^`\n]+?)\1/g, (m, tick, code) =>
      `<span class="md-mark">${tick}</span><span class="md-code">${code}</span><span class="md-mark">${tick}</span>`
    )
    .replace(/(\*\*|__)(?=\S)([\s\S]+?\S)\1/g, (m, mk, t) =>
      `<span class="md-mark">${mk}</span><span class="md-bold">${t}</span><span class="md-mark">${mk}</span>`
    )
    .replace(/(\*|_)(?=\S)([^\*_\n]+?\S)\1/g, (m, mk, t) =>
      `<span class="md-mark">${mk}</span><span class="md-em">${t}</span><span class="md-mark">${mk}</span>`
    )
    .replace(/(!?\[)([^\]]*)(\])(\()([^)]+)(\))/g, (m, lb, txt, rb, op, url, cp) =>
      `<span class="md-mark">${lb}</span><span class="md-link-text">${txt}</span><span class="md-mark">${rb}${op}</span><span class="md-link-url">${url}</span><span class="md-mark">${cp}</span>`
    );
}

function highlightLine(line, inFence) {
  if (inFence) {
    return `<span class="md-code-line">${line}</span>`;
  }
  // Fenced code start/end
  let m = line.match(/^(\s*)(```+)(.*)$/);
  if (m) {
    const lang = m[3] ? `<span class="md-fence-info">${m[3]}</span>` : '';
    return `${m[1]}<span class="md-fence">${m[2]}</span>${lang}`;
  }
  // ATX heading
  m = line.match(/^(\s*)(#{1,6})(\s+)(.*?)(\s*#*\s*)$/);
  if (m) {
    const inner = m[4] ? highlightInline(m[4]) : '';
    return `<span class="md-heading">${m[1]}<span class="md-mark">${m[2]}</span>${m[3]}${inner}${m[5]}</span>`;
  }
  // Horizontal rule
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    return `<span class="md-hr">${line}</span>`;
  }
  // Blockquote
  m = line.match(/^(\s*)(&gt;)(\s+)(.*)$/);
  if (m) {
    return `${m[1]}<span class="md-quote-mark">${m[2]}</span>${m[3]}<span class="md-quote">${highlightInline(m[4])}</span>`;
  }
  // Unordered list
  m = line.match(/^(\s*)([-*+])(\s+)(\[[ xX]\]\s+)?(.*)$/);
  if (m) {
    const task = m[4]
      ? `<span class="md-mark">${m[4].slice(0, 3)}</span>${m[4].slice(3)}`
      : '';
    return `${m[1]}<span class="md-list-mark">${m[2]}</span>${m[3]}${task}${highlightInline(m[5])}`;
  }
  // Ordered list
  m = line.match(/^(\s*)(\d+\.)(\s+)(.*)$/);
  if (m) {
    return `${m[1]}<span class="md-list-mark">${m[2]}</span>${m[3]}${highlightInline(m[4])}`;
  }
  // Table separator row
  if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) {
    return `<span class="md-mark">${line}</span>`;
  }
  // HTML-ish line
  if (/^\s*<\/?[a-zA-Z]/.test(line)) {
    return `<span class="md-html">${line}</span>`;
  }
  return highlightInline(line);
}

function highlightMarkdown(src) {
  const escaped = escHtml(src);
  const lines = escaped.split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    const fenceStart = !inFence && /^\s*```/.test(line);
    const fenceEnd = inFence && /^\s*```/.test(line);
    if (fenceStart || fenceEnd) {
      const html = highlightLine(line, false);
      inFence = fenceStart ? true : false;
      return html;
    }
    return highlightLine(line, inFence);
  });
  // trailing newline keeps last line height equal to textarea
  return out.join('\n') + '\n';
}

function updateSourceHighlight() {
  if (!sourceHighlight) return;
  sourceHighlight.innerHTML = highlightMarkdown(sourceTa.value);
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
  return { body: body.replace(/\s+$/, '') + '\n', ink };
}

function buildSource(body, strokes) {
  const json = JSON.stringify({ v: 1, strokes });
  const trimmed = body.replace(/\s*$/, '');
  return `${trimmed}\n\n\`\`\`ink\n${json}\n\`\`\`\n`;
}

function getSource() {
  return buildSource(state.body, [...state.strokes, ...state.orphans]);
}

function setBodyFromString(text) {
  const { body, ink } = parseSource(text);
  state.body = body;
  state.strokes = (ink.strokes || []).filter((s) => s && s.anchor && Array.isArray(s.points));
  state.orphans = [];
  state.blocks = splitIntoBlocks(state.body);
  state.activeIdx = null;
}

/* =====================================================================
 * Block model (Write mode)
 * ===================================================================*/

function splitIntoBlocks(src) {
  const lines = (src || '').split('\n');
  const blocks = [];
  let buf = [];
  let inFence = false;
  const flush = () => {
    if (buf.length) {
      blocks.push(buf.join('\n'));
      buf = [];
    }
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      flush();
    } else {
      buf.push(line);
    }
  }
  flush();
  return blocks.length ? blocks : [''];
}

function bodyFromBlocks() {
  return state.blocks.join('\n\n').replace(/\s*$/, '') + '\n';
}

function blockKind(src) {
  const first = (src || '').split('\n')[0] || '';
  const m = first.match(/^(#{1,4})\s+/);
  if (m) return 'h' + m[1].length;
  return '';
}

function renderWriteEditor() {
  writeEditor.innerHTML = '';
  state.blocks.forEach((src, i) => {
    const div = document.createElement('div');
    div.className = 'block';
    div.dataset.idx = String(i);
    if (i === state.activeIdx) {
      div.classList.add('active');
      const ta = document.createElement('textarea');
      ta.className = 'block-source';
      ta.value = src;
      ta.spellcheck = true;
      ta.dataset.kind = blockKind(src);
      ta.addEventListener('input', () => onBlockInput(i, ta));
      ta.addEventListener('keydown', (e) => onBlockKey(e, i, ta));
      ta.addEventListener('blur', () => commitActiveBlock());
      div.appendChild(ta);
    } else {
      div.innerHTML = renderBlockHTML(src);
      div.addEventListener('mousedown', (e) => {
        if (e.target.closest('a, button, input, textarea')) return;
        e.preventDefault();
        activateBlock(i);
      });
    }
    writeEditor.appendChild(div);
  });
}

function activateBlock(idx) {
  if (state.activeIdx === idx) return;
  if (state.activeIdx != null) commitActiveBlock(false);
  state.activeIdx = idx;
  renderWriteEditor();
  requestAnimationFrame(() => {
    const ta = writeEditor.querySelector(`[data-idx="${idx}"] textarea`);
    if (ta) {
      ta.focus();
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
      autoSize(ta);
    }
  });
}

function commitActiveBlock(rerender = true) {
  if (state.activeIdx == null) return;
  const ta = writeEditor.querySelector(`[data-idx="${state.activeIdx}"] textarea`);
  if (!ta) {
    state.activeIdx = null;
    return;
  }
  const text = ta.value;
  const newBlocks = splitIntoBlocks(text);
  state.blocks.splice(state.activeIdx, 1, ...newBlocks);
  if (state.blocks.length === 0) state.blocks = [''];
  state.activeIdx = null;
  state.body = bodyFromBlocks();
  if (rerender) renderWriteEditor();
}

function onBlockInput(idx, ta) {
  state.blocks[idx] = ta.value;
  state.body = bodyFromBlocks();
  ta.dataset.kind = blockKind(ta.value);
  autoSize(ta);
  markDirty();
  updateTOC();
}

function onBlockKey(e, idx, ta) {
  // Backspace at start of block: merge with previous
  if (
    e.key === 'Backspace' &&
    ta.selectionStart === 0 &&
    ta.selectionEnd === 0 &&
    idx > 0
  ) {
    e.preventDefault();
    const prev = state.blocks[idx - 1];
    const cur = state.blocks[idx];
    const merged = prev + (cur ? '\n' + cur : '');
    state.blocks[idx - 1] = merged;
    state.blocks.splice(idx, 1);
    state.activeIdx = idx - 1;
    state.body = bodyFromBlocks();
    renderWriteEditor();
    requestAnimationFrame(() => {
      const newTa = writeEditor.querySelector(`[data-idx="${idx - 1}"] textarea`);
      if (newTa) {
        newTa.focus();
        newTa.setSelectionRange(prev.length, prev.length);
        autoSize(newTa);
      }
    });
    markDirty();
    updateTOC();
    return;
  }
  // Tab: insert two spaces (no focus jump)
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
    ta.setSelectionRange(start + 2, start + 2);
    onBlockInput(idx, ta);
  }
}

function autoSize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function focusEditorEnd() {
  if (!state.blocks.length) state.blocks = [''];
  activateBlock(state.blocks.length - 1);
}

/* =====================================================================
 * Geometry: RDP, decimation, anchoring
 * ===================================================================*/

function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  let maxD = 0, idx = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = rdp(points.slice(0, idx + 1), eps);
    const right = rdp(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}
function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const px = a.x + t * dx, py = a.y + t * dy;
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
    let vx = 0, vy = 0;
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
    if (!hEl) { newOrphans.push(s); continue; }
    stillAnchored.push(s);

    const hTop = hEl.getBoundingClientRect().top - docTop;
    const abs = s.points.map(([x, y, , , p]) => ({
      x: x * w, y: hTop + y, pressure: p,
    }));

    const stroke = window.getStroke
      ? window.getStroke(abs, {
          size: 3.2, thinning: 0.5, smoothing: 0.6, streamline: 0.5,
          simulatePressure: !s.pen, last: true,
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
    size: 3.2, thinning: 0.5, smoothing: 0.6, streamline: 0.5,
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
  if (livePath) { livePath.remove(); livePath = null; }
  if (stroke) {
    state.strokes.push(stroke);
    markDirty();
  }
  renderStrokes();
}

function undo() {
  if (!state.strokes.length) return;
  state.strokes.pop();
  markDirty();
  renderStrokes();
}

/* =====================================================================
 * Mode switching
 * ===================================================================*/

async function setMode(mode) {
  if (mode === state.mode) return;

  // exit current mode
  if (state.mode === 'write') {
    commitActiveBlock(false);
  } else if (state.mode === 'source') {
    setBodyFromString(sourceTa.value);
  }

  state.mode = mode;
  document.body.dataset.mode = mode;
  $('btn-write').classList.toggle('active', mode === 'write');
  $('btn-source').classList.toggle('active', mode === 'source');
  $('btn-ink').classList.toggle('active', mode === 'ink');
  toggleHidden($('ink-tools'), mode !== 'ink');
  toggleHidden($('write-tools'), mode === 'ink');

  if (mode === 'write') {
    overlay.innerHTML = '';
    state.blocks = splitIntoBlocks(state.body);
    state.activeIdx = null;
    renderWriteEditor();
    updateOrphanTray();
  } else if (mode === 'source') {
    overlay.innerHTML = '';
    sourceTa.value = getSource();
    updateLineGutter();
    updateSourceHighlight();
    setTimeout(() => sourceTa.focus(), 0);
    updateOrphanTray();
  } else {
    docContent.innerHTML = renderMarkdown(state.body);
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
 * Theme & sidebar
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

function setSidebarHidden(hidden, persist = true) {
  document.body.classList.toggle('sidebar-hidden', hidden);
  if (hidden) document.body.classList.remove('sidebar-open');
  if (persist) {
    try { localStorage.setItem(STORAGE_SIDEBAR, hidden ? '1' : '0'); } catch (e) {}
  }
}

function toggleSidebar() {
  const isMobile = matchMedia('(max-width: 900px)').matches;
  if (isMobile) {
    document.body.classList.toggle('sidebar-open');
  } else {
    setSidebarHidden(!document.body.classList.contains('sidebar-hidden'));
  }
}

function openSidebar() {
  document.body.classList.add('sidebar-open');
  setSidebarHidden(false);
}
function closeSidebar() {
  document.body.classList.remove('sidebar-open');
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
      renderStrokes();
    };
  } else {
    tray.classList.remove('visible');
  }
}

function updateLineGutter() {
  const lines = (sourceTa.value.match(/\n/g) || []).length + 1;
  let s = '';
  for (let i = 1; i <= lines; i++) s += i + '\n';
  lineGutter.textContent = s;
}

function updateTOC() {
  const lines = (state.body || '').split('\n');
  const items = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
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
function escapeAttr(s) { return s.replace(/"/g, '&quot;'); }

function jumpToHeading(lineIdx, text) {
  if (state.mode === 'ink') {
    const id = headingId(text);
    const el =
      document.getElementById(id) ||
      [...docContent.querySelectorAll('h1,h2')].find((h) => h.textContent.trim() === text.trim());
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (state.mode === 'write') {
    const idx = state.blocks.findIndex((b) => {
      const first = (b || '').split('\n')[0];
      const m = first.match(/^#{1,2}\s+(.+?)\s*#*\s*$/);
      return m && m[1].trim() === text.trim();
    });
    if (idx >= 0) {
      activateBlock(idx);
      const block = writeEditor.querySelector(`[data-idx="${idx}"]`);
      if (block) block.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }
  // source mode
  const lines = sourceTa.value.split('\n');
  let pos = 0;
  for (let i = 0; i < lineIdx && i < lines.length; i++) pos += lines[i].length + 1;
  sourceTa.focus();
  sourceTa.setSelectionRange(pos, pos + (lines[lineIdx] ? lines[lineIdx].length : 0));
  const ratio = pos / Math.max(sourceTa.value.length, 1);
  window.scrollTo({
    top: sourceTa.offsetTop + sourceTa.offsetHeight * ratio - 80,
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
  showToast._tid = setTimeout(() => { t.style.display = 'none'; }, 3500);
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
    try { localStorage.setItem(STORAGE_KEY, getSource()); } catch (e) {}
  }, 600);
}
function loadAutosave() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && v.trim() ? v : null;
  } catch (e) { return null; }
}
function clearAutosave() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
}

function suggestFilename() {
  const m = state.body.match(/^#\s+(.+)$/m);
  const title = m ? m[1].trim() : 'inkmark';
  return slugify(title).slice(0, 60) + '.md';
}

function saveFile() {
  if (state.mode === 'write') commitActiveBlock(false);
  if (state.mode === 'source') setBodyFromString(sourceTa.value);
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

async function applyLoadedSource(text, label) {
  setBodyFromString(text);
  markClean();
  clearAutosave();
  if (state.mode === 'write') {
    renderWriteEditor();
  } else if (state.mode === 'source') {
    sourceTa.value = getSource();
    updateLineGutter();
    updateSourceHighlight();
  } else {
    docContent.innerHTML = renderMarkdown(state.body);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(r));
    renderStrokes();
  }
  updateTOC();
  if (label) showToast(label);
}

async function loadFile(file) {
  if (!(await maybeWarnBeforeReplacing())) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '').replace(/\r\n?/g, '\n');
    applyLoadedSource(text, 'Loaded ' + (file.name || 'file'));
  };
  reader.onerror = () => showToast('Could not read file');
  reader.readAsText(file);
}

async function newDocument() {
  if (!(await maybeWarnBeforeReplacing())) return;
  await applyLoadedSource(BLANK_DOC, 'New document');
  if (state.mode === 'write') {
    requestAnimationFrame(() => activateBlock(0));
  }
}

/* =====================================================================
 * Editing helpers
 * ===================================================================*/

function insertSection() {
  if (state.mode === 'source') {
    const pos = sourceTa.selectionStart;
    const before = sourceTa.value.slice(0, pos);
    const after = sourceTa.value.slice(pos);
    const lead =
      before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const insert = `${lead}## New section\n\n`;
    sourceTa.value = before + insert + after;
    const caret = before.length + lead.length + 3;
    sourceTa.setSelectionRange(caret, caret + 'New section'.length);
    sourceTa.focus();
    setBodyFromString(sourceTa.value);
    markDirty();
    updateLineGutter();
    updateTOC();
    return;
  }
  // write mode
  let idx = state.activeIdx != null ? state.activeIdx + 1 : state.blocks.length;
  if (state.activeIdx != null) commitActiveBlock(false);
  state.blocks.splice(idx, 0, '## New section');
  state.body = bodyFromBlocks();
  state.activeIdx = idx;
  renderWriteEditor();
  requestAnimationFrame(() => {
    const ta = writeEditor.querySelector(`[data-idx="${idx}"] textarea`);
    if (ta) {
      ta.focus();
      ta.setSelectionRange(3, 3 + 'New section'.length);
      autoSize(ta);
    }
  });
  markDirty();
  updateTOC();
}

/* =====================================================================
 * PWA: SW + install + file_handlers
 * ===================================================================*/

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: window-controls-overlay)').matches
    || window.navigator.standalone === true;
}

function bindInstallPrompt() {
  if (isStandalone()) {
    $('btn-install').hidden = true;
    return;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('btn-install-label').textContent = 'Install app';
  });

  $('btn-install').addEventListener('click', async () => {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      const { outcome } = await state.installPrompt.userChoice;
      state.installPrompt = null;
      if (outcome !== 'accepted') showToast('Install dismissed');
      return;
    }
    const ua = navigator.userAgent;
    const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
    const isFirefox = /Firefox/i.test(ua);
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    const isSafariDesktop = /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS/i.test(ua) && !isMobile;

    let msg;
    if (isFirefox && isMobile) {
      msg = 'Firefox: tap the ⋮ menu → Install. (You can also long-press the address bar.)';
    } else if (isFirefox) {
      msg = 'Firefox desktop needs the "Progressive Web Apps for Firefox" add-on to install. Then re-open this page from there.';
    } else if (isIOS) {
      msg = 'iOS: tap Share, then "Add to Home Screen".';
    } else if (isSafariDesktop) {
      msg = 'Safari: File menu → Add to Dock (macOS 14+).';
    } else {
      msg = 'Use your browser menu: Install app, or Add to Home Screen.';
    }
    showToast(msg);
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
        await applyLoadedSource(text, 'Opened ' + file.name);
        break;
      } catch (e) { /* ignore */ }
    }
  });
}

/* =====================================================================
 * Init
 * ===================================================================*/

function init() {
  setTheme(state.theme);
  document.body.dataset.mode = 'write';

  // restore sidebar pref
  try {
    const hidden = localStorage.getItem(STORAGE_SIDEBAR) === '1';
    if (hidden && !matchMedia('(max-width: 900px)').matches) {
      setSidebarHidden(true, false);
    }
  } catch (e) {}

  // restore autosave or fall back to demo
  const url = new URL(location.href);
  const wantsNew = url.searchParams.get('new') === '1';
  const restored = !wantsNew && loadAutosave();
  if (restored) {
    setBodyFromString(restored);
    showToast('Restored from autosave');
  } else if (wantsNew) {
    setBodyFromString(BLANK_DOC);
    clearAutosave();
  } else {
    setBodyFromString(DEMO);
    clearAutosave();
  }
  markClean();

  renderWriteEditor();
  updateTOC();

  // Source mode listeners
  sourceTa.addEventListener('input', () => {
    setBodyFromString(sourceTa.value);
    markDirty();
    updateLineGutter();
    updateSourceHighlight();
    updateTOC();
  });
  sourceTa.addEventListener('scroll', () => {
    lineGutter.scrollTop = sourceTa.scrollTop;
    if (sourceHighlight) sourceHighlight.scrollTop = sourceTa.scrollTop;
  });

  // Write editor: click below blocks → focus end
  writeEditor.addEventListener('click', (e) => {
    if (e.target === writeEditor) focusEditorEnd();
  });

  // toolbar
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
  $('brand-home').onclick = (e) => { e.preventDefault(); newDocument(); };

  // sidebar
  $('sidebar-toggle-btn').onclick = toggleSidebar;
  $('sidebar-hide-btn').onclick = toggleSidebar;
  $('sidebar-scrim').onclick = closeSidebar;

  // ink overlay
  overlay.addEventListener('pointerdown', startStroke);
  overlay.addEventListener('pointermove', moveStroke);
  overlay.addEventListener('pointerup', endStroke);
  overlay.addEventListener('pointercancel', endStroke);
  overlay.addEventListener('lostpointercapture', endStroke);

  // shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') { e.preventDefault(); saveFile(); }
    else if (mod && k === 'o') { e.preventDefault(); $('file-input').click(); }
    else if (mod && k === 'e') {
      e.preventDefault();
      const order = ['write', 'source', 'ink'];
      const next = order[(order.indexOf(state.mode) + 1) % order.length];
      setMode(next);
    } else if (mod && k === 'z' && state.mode === 'ink' && !e.shiftKey) {
      e.preventDefault(); undo();
    } else if (mod && e.shiftKey && k === 'n') {
      e.preventDefault(); newDocument();
    } else if (mod && e.key === '\\') {
      e.preventDefault(); toggleSidebar();
    } else if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
      closeSidebar();
    }
  });

  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (state.mode === 'ink') renderStrokes(); }, 100);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  registerSW();
  bindInstallPrompt();
  handleLaunchQueue();
}

if (window.getStroke) init();
else window.addEventListener('inkmark:ready', init, { once: true });
