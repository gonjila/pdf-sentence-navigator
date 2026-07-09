// PDF Sentence Navigator — viewer logic.
//
// Loads a PDF (from a local file or a URL), renders every page to canvas
// plus a real pdf.js text layer, indexes that text layer into sentences,
// and lets the user step through sentences with Tab / Shift+Tab.
//
// Everything here runs locally inside this extension page. The only
// network request this file ever makes is fetching the PDF bytes
// themselves when the user supplies a URL — nothing is ever sent out.

import * as pdfjsLib from "./pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "./pdfjs/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const CMAP_URL = new URL("./pdfjs/cmaps/", import.meta.url).toString();
const STANDARD_FONT_DATA_URL = new URL("./pdfjs/standard_fonts/", import.meta.url).toString();

const RENDER_SCALE = 1.5;

const els = {
  pageContainer: document.getElementById("pageContainer"),
  fileInput: document.getElementById("fileInput"),
  urlInput: document.getElementById("urlInput"),
  loadUrlBtn: document.getElementById("loadUrlBtn"),
  docTitle: document.getElementById("docTitle"),
  emptyState: document.getElementById("emptyState"),
  statusBadge: document.getElementById("statusBadge"),
};

const state = {
  sentences: [], // { text, runs: [{ node, startOffset, endOffset }] }
  currentIndex: -1,
  overlays: [],
  loading: false,
};

function setEmptyState(visible) {
  els.emptyState.classList.toggle("hidden", !visible);
}

function setStatus(text) {
  if (!text) {
    els.statusBadge.style.display = "none";
    return;
  }
  els.statusBadge.style.display = "block";
  els.statusBadge.textContent = text;
}

function showLoadingBar(fraction) {
  let bar = document.getElementById("loadingBar");
  if (fraction == null) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "loadingBar";
    document.body.appendChild(bar);
  }
  bar.style.width = `${Math.round(fraction * 100)}%`;
}

// ---------------------------------------------------------------------
// Loading a document (from File object or ArrayBuffer/URL).
// ---------------------------------------------------------------------
async function loadFromArrayBuffer(data, label) {
  resetDocument();
  state.loading = true;
  setEmptyState(false);
  setStatus("იტვირთება PDF…");
  showLoadingBar(0);

  try {
    const loadingTask = pdfjsLib.getDocument({
      data,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    });
    loadingTask.onProgress = ({ loaded, total }) => {
      if (total) showLoadingBar(loaded / total);
    };
    const pdf = await loadingTask.promise;
    els.docTitle.textContent = label || "";

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      showLoadingBar(pageNum / pdf.numPages);
      setStatus(`გვერდების რენდერი: ${pageNum} / ${pdf.numPages}`);
      // eslint-disable-next-line no-await-in-loop
      await renderPage(pdf, pageNum);
    }

    showLoadingBar(null);
    state.sentences = buildSentenceIndex();
    state.currentIndex = -1;
    if (state.sentences.length > 0) {
      setStatus(`მზადაა — ${state.sentences.length} წინადადება. დააჭირეთ Tab-ს დასაწყებად.`);
    } else {
      setStatus("ტექსტი ვერ მოიძებნა ამ დოკუმენტში (შესაძლოა სკანირებული/სურათოვანი PDF იყოს).");
    }
  } catch (err) {
    console.error(err);
    showLoadingBar(null);
    setStatus(`შეცდომა PDF-ის ჩატვირთვისას: ${err.message || err}`);
    setEmptyState(true);
  } finally {
    state.loading = false;
  }
}

async function renderPage(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  const pageDiv = document.createElement("div");
  pageDiv.className = "pdfPage";
  pageDiv.style.width = `${viewport.width}px`;
  pageDiv.style.height = `${viewport.height}px`;
  pageDiv.style.setProperty("--scale-factor", viewport.scale);

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  pageDiv.appendChild(canvas);

  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  pageDiv.appendChild(textLayerDiv);

  els.pageContainer.appendChild(pageDiv);

  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  const textContent = await page.getTextContent();
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: textContent,
    container: textLayerDiv,
    viewport,
  });
  await textLayer.render();
}

function resetDocument() {
  els.pageContainer.innerHTML = "";
  state.sentences = [];
  state.currentIndex = -1;
  clearOverlays();
  setStatus(null);
}

// ---------------------------------------------------------------------
// Sentence indexing over the rendered text layer(s).
// ---------------------------------------------------------------------
function collectSpanTextNodes() {
  const spans = els.pageContainer.querySelectorAll(".textLayer span");
  const out = [];
  for (const span of spans) {
    const node = span.firstChild;
    if (node && node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
      out.push(node);
    }
  }
  return out;
}

function buildSentenceIndex() {
  const nodes = collectSpanTextNodes();
  if (nodes.length === 0) return [];

  const map = [];
  let fullText = "";
  for (const node of nodes) {
    const text = node.textContent;
    for (let i = 0; i < text.length; i++) map.push({ node, offset: i });
    fullText += text;
    map.push(null); // separator between text-layer spans
    fullText += " ";
  }

  const sentenceRegex = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g;
  const rawMatches = fullText.match(sentenceRegex) || [];

  const sentences = [];
  let cursor = 0;
  for (const raw of rawMatches) {
    const start = fullText.indexOf(raw, cursor);
    if (start === -1) continue;
    const end = start + raw.length;
    cursor = end;

    const text = raw.trim();
    if (text.length === 0) continue;

    const runs = [];
    let current = null;
    for (let i = start; i < end; i++) {
      const entry = map[i];
      if (!entry) {
        current = null;
        continue;
      }
      if (current && current.node === entry.node && current.endOffset === entry.offset) {
        current.endOffset = entry.offset + 1;
      } else {
        current = { node: entry.node, startOffset: entry.offset, endOffset: entry.offset + 1 };
        runs.push(current);
      }
    }

    if (runs.length > 0) sentences.push({ text, runs });
  }

  return sentences;
}

// ---------------------------------------------------------------------
// Highlighting.
// ---------------------------------------------------------------------
function getRectsForSentence(sentence) {
  const rects = [];
  for (const run of sentence.runs) {
    try {
      const range = document.createRange();
      range.setStart(run.node, run.startOffset);
      range.setEnd(run.node, run.endOffset);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) rects.push(rect);
      }
    } catch (e) {
      // Ignore stale ranges.
    }
  }
  return rects;
}

function clearOverlays() {
  for (const el of state.overlays) el.remove();
  state.overlays = [];
}

function renderHighlight(sentence) {
  clearOverlays();
  if (!sentence) return;
  for (const rect of getRectsForSentence(sentence)) {
    const div = document.createElement("div");
    div.className = "__sentence_highlight__";
    div.style.left = `${rect.left}px`;
    div.style.top = `${rect.top}px`;
    div.style.width = `${rect.width}px`;
    div.style.height = `${rect.height}px`;
    document.body.appendChild(div);
    state.overlays.push(div);
  }
}

function scrollToSentence(sentence) {
  const el = sentence.runs[0].node.parentElement;
  if (el && el.scrollIntoView) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
  }
}

function updateStatusForCurrent() {
  if (state.sentences.length === 0) return;
  setStatus(`წინადადება ${state.currentIndex + 1} / ${state.sentences.length}`);
}

function goTo(index) {
  if (state.sentences.length === 0) return;
  const clamped = Math.max(0, Math.min(index, state.sentences.length - 1));
  state.currentIndex = clamped;
  const sentence = state.sentences[clamped];
  renderHighlight(sentence);
  scrollToSentence(sentence);
  updateStatusForCurrent();
}

function next() {
  if (state.sentences.length === 0) return;
  goTo(state.currentIndex + 1);
}

function prev() {
  if (state.sentences.length === 0) return;
  goTo(state.currentIndex - 1);
}

// ---------------------------------------------------------------------
// Keyboard handling.
// ---------------------------------------------------------------------
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Tab") return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;

    const active = document.activeElement;
    const tag = active && active.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (active && active.isContentEditable)) {
      return;
    }
    if (state.sentences.length === 0) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.shiftKey) prev();
    else next();
  },
  true,
);

let rafPending = false;
function scheduleReposition() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (state.currentIndex >= 0 && state.sentences[state.currentIndex]) {
      renderHighlight(state.sentences[state.currentIndex]);
    }
  });
}
window.addEventListener("scroll", scheduleReposition, true);
window.addEventListener("resize", scheduleReposition, true);

// ---------------------------------------------------------------------
// Source selection: local file, URL query param, or URL input box.
// ---------------------------------------------------------------------
els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files[0];
  if (!file) return;
  const buffer = await file.arrayBuffer();
  loadFromArrayBuffer(new Uint8Array(buffer), file.name);
});

async function loadFromUrl(url) {
  if (!url) return;
  setStatus("იტვირთება URL-დან…");
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    let label = url;
    try {
      label = decodeURIComponent(url.split("/").pop());
    } catch (e) {
      /* keep raw url as label */
    }
    await loadFromArrayBuffer(new Uint8Array(buffer), label);
  } catch (err) {
    console.error(err);
    setStatus(`ვერ ჩაიტვირთა URL-დან: ${err.message || err}`);
    setEmptyState(true);
  }
}

els.loadUrlBtn.addEventListener("click", () => loadFromUrl(els.urlInput.value.trim()));
els.urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadFromUrl(els.urlInput.value.trim());
});

// Auto-load if opened via the right-click "Open with Sentence Navigator"
// context menu (background.js appends ?url=...).
const params = new URLSearchParams(window.location.search);
const initialUrl = params.get("url");
if (initialUrl) {
  els.urlInput.value = initialUrl;
  loadFromUrl(initialUrl);
} else {
  setEmptyState(true);
}
