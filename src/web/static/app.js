// momento dashboard — vanilla JS, no build step.
//
// Left pane: SSE feed of newly indexed sessions (/api/feed).
// Right pane: search + browse over /api/search, /api/sessions/recent,
//             and /api/sessions/:id for detail.

import { renderMarkdown } from "/static/markdown.js";

const $ = (id) => document.getElementById(id);

const feed = $("feed");
const feedEmpty = $("feed-empty");
const pauseBtn = $("pause-btn");
const feedPill = $("feed-pill");
const uptimePill = $("uptime-pill");
const countPill = $("count-pill");
const dbPathEl = $("db-path");
const searchForm = $("search-form");
const searchInput = $("search-input");
const searchStatus = $("search-status");
const searchResults = $("search-results");
const detailPanel = $("detail-panel");
const detailTitle = $("detail-title");
const detailMeta = $("detail-meta");
const detailList = $("detail-list");
const detailClose = $("detail-close");

// Persisted view state: filter chips, search query, and recent-mode are
// stored under `momento.ui.*` keys so a page reload doesn't lose context.
// Stored as plain strings (booleans serialized "1"/"0"). Stale keys from
// removed features survive harmlessly; they're just never read.
const PERSIST_PREFIX = "momento.ui.";
const persist = {
  get(key, fallback = "") {
    try {
      const v = localStorage.getItem(PERSIST_PREFIX + key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PERSIST_PREFIX + key, value);
    } catch {
      /* private browsing, quota, etc. */
    }
  },
};

let paused = false;
let activeClient = persist.get("activeClient", "");
let activeCategory = persist.get("activeCategory", "");
let recentMode = persist.get("recentMode", "1") !== "0";
let currentSession = null;
let currentDetail = null;
let currentTab = "messages";
const MAX_FEED_ROWS = 200;

function fmtTime(ts) {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toTimeString().slice(0, 8);
}

function basename(p) {
  if (!p) return "—";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function shorten(s, n = 140) {
  if (!s) return "";
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Build a row for the live feed (left pane).
function appendFeedRow(ev) {
  if (paused) return;
  feedEmpty.hidden = true;
  feed.hidden = false;
  const row = document.createElement("li");
  row.className = "event-row";
  row.dataset.id = String(ev.id);
  row.dataset.sessionId = ev.session_id;
  const time = document.createElement("time");
  time.textContent = fmtTime(ev.timestamp);
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.dataset.client = ev.client || "";
  badge.textContent = ev.client || "?";
  const snippet = document.createElement("span");
  snippet.className = "snippet";
  const proj = document.createElement("div");
  proj.className = "project";
  proj.textContent = basename(ev.project_path);
  const text = document.createElement("div");
  text.textContent = shorten(ev.first_prompt || ev.summary || "(no prompt)");
  snippet.append(proj, text);
  row.append(time, badge, snippet);
  row.addEventListener("click", () => openDetail(ev.session_id));
  feed.prepend(row);
  while (feed.children.length > MAX_FEED_ROWS) feed.lastElementChild.remove();
}

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.setAttribute("aria-pressed", String(paused));
  pauseBtn.textContent = paused ? "Resume" : "Pause";
});

function connectFeed() {
  const es = new EventSource("/api/feed");
  es.addEventListener("hello", () => {
    feedPill.dataset.state = "ok";
    feedPill.textContent = "feed: live";
  });
  es.addEventListener("session_indexed", (e) => {
    try {
      appendFeedRow(JSON.parse(e.data));
    } catch (err) {
      console.error("bad feed payload", err);
    }
  });
  es.onerror = () => {
    feedPill.dataset.state = "error";
    feedPill.textContent = "feed: reconnecting…";
  };
}

async function pollStatus() {
  try {
    const r = await fetch("/api/status");
    if (!r.ok) return;
    const j = await r.json();
    uptimePill.textContent = `uptime: ${j.uptime_seconds}s`;
    countPill.textContent = `sessions: ${j.session_count}`;
    dbPathEl.textContent = `db: ${j.db_path} (${formatBytes(j.db_size_bytes)})`;
  } catch {
    // feed pill already surfaces connection issues
  }
}

function formatBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function renderSessions(rows, { snippetGetter } = {}) {
  searchResults.innerHTML = "";
  if (!rows.length) {
    searchStatus.textContent = "No matches.";
    return;
  }
  searchStatus.textContent = `${rows.length} result${rows.length === 1 ? "" : "s"}.`;
  for (const r of rows) {
    const sessionId = r.id || r.sessionId;
    const li = document.createElement("li");
    li.className = "result-row";
    li.tabIndex = 0;
    li.dataset.sessionId = sessionId;
    const time = document.createElement("time");
    time.textContent = (r.modified || "").slice(0, 16).replace("T", " ");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.dataset.client = r.client || "";
    badge.textContent = r.client || "?";
    const snippet = document.createElement("span");
    snippet.className = "snippet";
    const proj = document.createElement("div");
    proj.className = "project";
    proj.textContent = basename(r.projectPath || r.project_path || "");
    const text = document.createElement("div");
    const snippetText = snippetGetter ? snippetGetter(r) : shorten(r.summary || r.firstPrompt || "(no prompt)");
    text.innerHTML = highlight(snippetText);
    snippet.append(proj, text);
    const score = document.createElement("span");
    score.className = "score";
    if (typeof r.score === "number") score.textContent = r.score.toFixed(2);
    li.append(time, badge, snippet, score);
    li.addEventListener("click", () => openDetail(sessionId));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter") openDetail(sessionId);
    });
    searchResults.appendChild(li);
  }
}

// Escape HTML then convert [ and ] from FTS snippet markers into <mark>.
function highlight(text) {
  if (!text) return "";
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc.replace(/\[([^\]]+)\]/g, "<mark>$1</mark>");
}

async function loadRecent() {
  searchStatus.textContent = "Loading recent…";
  try {
    const params = new URLSearchParams({ n: "2000" });
    if (activeClient) params.set("client", activeClient);
    if (activeCategory) params.set("category", activeCategory);
    const r = await fetch(`/api/sessions/recent?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderSessions(j.sessions || []);
  } catch (err) {
    searchStatus.textContent = `Error: ${err.message}`;
  }
}

async function runSearch(q) {
  if (!q) {
    if (recentMode) await loadRecent();
    else { searchResults.innerHTML = ""; searchStatus.textContent = ""; }
    return;
  }
  searchStatus.textContent = "Searching…";
  try {
    const params = new URLSearchParams({ q, limit: "500" });
    if (activeClient) params.set("client", activeClient);
    if (activeCategory) params.set("category", activeCategory);
    const r = await fetch(`/api/search?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    // Group hits by session, keep best snippet per session.
    const bySession = new Map();
    for (const h of j.hits || []) {
      if (!bySession.has(h.sessionId)) bySession.set(h.sessionId, h);
    }
    const rows = [...bySession.values()].map((h) => ({
      id: h.sessionId,
      projectPath: h.projectPath,
      summary: h.summary,
      firstPrompt: h.snippet,
      client: h.client,
      score: h.score,
      modified: "",
    }));
    renderSessions(rows, { snippetGetter: (r) => r.firstPrompt });
  } catch (err) {
    searchStatus.textContent = `Search error: ${err.message}`;
  }
}

async function openDetail(sessionId) {
  detailPanel.hidden = false;
  detailTitle.textContent = sessionId;
  detailMeta.textContent = "Loading…";
  detailList.innerHTML = "";
  currentSession = sessionId;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    currentDetail = j;
    const s = j.session || {};
    detailTitle.textContent = s.summary || s.firstPrompt || sessionId;
    detailMeta.textContent =
      `${s.client || "?"} · ${basename(s.projectPath || "")} · ` +
      `${s.messageCount ?? "?"} messages · ${(s.modified || "").slice(0, 16).replace("T", " ")}`;
    renderDetailTab(currentTab);
    detailTitle.focus?.();
  } catch (err) {
    detailMeta.textContent = `Could not load session: ${err.message}`;
  }
}

function renderDetailTab(tab) {
  currentTab = tab;
  for (const b of document.querySelectorAll(".detail-tabs .tab")) {
    b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
  }
  detailList.innerHTML = "";
  if (!currentDetail) return;
  if (tab === "messages") {
    for (const m of currentDetail.messages || []) {
      const li = document.createElement("li");
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = m.role;
      const body = document.createElement("div");
      body.className = "markdown";
      body.innerHTML = renderMarkdown(m.content_snippet || "");
      li.append(role, body);
      detailList.appendChild(li);
    }
  } else if (tab === "tools") {
    for (const t of currentDetail.tool_calls || []) {
      const li = document.createElement("li");
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = t.tool_name;
      li.append(role, document.createTextNode(shorten(t.input_json || "", 240)));
      detailList.appendChild(li);
    }
  } else if (tab === "files") {
    for (const f of currentDetail.file_touches || []) {
      const li = document.createElement("li");
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = `${f.operation}[${f.touch_source}]`;
      li.append(role, document.createTextNode(f.file_path || ""));
      detailList.appendChild(li);
    }
  }
}

document.querySelectorAll(".filters .chip[data-client]").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeClient = btn.dataset.client;
    persist.set("activeClient", activeClient);
    for (const b of document.querySelectorAll(".filters .chip[data-client]")) {
      b.setAttribute("aria-pressed", String(b === btn));
    }
    const q = searchInput.value.trim();
    if (q) runSearch(q);
    else loadRecent();
  });
});

// Category chips: the "any kind" chip is static; the rest are injected after
// /api/categories returns. Delegated handler picks up both static and dynamic.
const categoryFiltersEl = document.getElementById("category-filters");
function setActiveCategory(value) {
  activeCategory = value;
  persist.set("activeCategory", value);
  for (const b of categoryFiltersEl.querySelectorAll(".chip")) {
    b.setAttribute("aria-pressed", String((b.dataset.category || "") === value));
  }
}
categoryFiltersEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip[data-category]");
  if (!btn) return;
  setActiveCategory(btn.dataset.category || "");
  const q = searchInput.value.trim();
  if (q) runSearch(q);
  else loadRecent();
});

async function loadCategoryChips() {
  try {
    const r = await fetch("/api/categories");
    if (!r.ok) return;
    const j = await r.json();
    const cats = Array.isArray(j.categories) ? j.categories : [];
    // Keep the static "any kind" chip first; rebuild the rest from the API
    // response, preserving DESC ordering from the backend.
    for (const b of categoryFiltersEl.querySelectorAll(".chip[data-category]:not([data-category=''])")) {
      b.remove();
    }
    for (const c of cats) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.dataset.category = c.category;
      btn.setAttribute("aria-pressed", String(c.category === activeCategory));
      btn.textContent = `${c.category} (${c.sessions})`;
      categoryFiltersEl.appendChild(btn);
    }
    // Sync the "any kind" chip's pressed state too.
    const anyChip = categoryFiltersEl.querySelector(".chip[data-category='']");
    if (anyChip) anyChip.setAttribute("aria-pressed", String(activeCategory === ""));
  } catch {
    /* leave chips empty if endpoint missing — v3 DBs that haven't been rebuilt */
  }
}

document.getElementById("recent-toggle").addEventListener("click", (e) => {
  recentMode = !recentMode;
  persist.set("recentMode", recentMode ? "1" : "0");
  e.currentTarget.setAttribute("aria-pressed", String(recentMode));
  const q = searchInput.value.trim();
  if (!q && recentMode) loadRecent();
  if (!recentMode && !q) { searchResults.innerHTML = ""; searchStatus.textContent = ""; }
});

// SVG sparkline of sessions-per-day. ViewBox 120x24; pad 1px so the bottom-
// most line draws inside the box. Linear path from oldest (left) to newest
// (right). Empty data → blank box, no error.
async function loadSparkline() {
  const el = document.getElementById("activity-sparkline");
  if (!el) return;
  try {
    const r = await fetch("/api/activity?days=14");
    if (!r.ok) return;
    const j = await r.json();
    const pts = Array.isArray(j.points) ? j.points : [];
    if (pts.length === 0) {
      el.innerHTML = "";
      return;
    }
    const max = Math.max(...pts.map((p) => p.n), 1);
    const W = 120, H = 24, PAD = 1;
    const xStep = pts.length > 1 ? (W - 2 * PAD) / (pts.length - 1) : 0;
    const coords = pts.map((p, i) => {
      const x = PAD + i * xStep;
      const y = H - PAD - ((H - 2 * PAD) * p.n) / max;
      return [x, y];
    });
    const linePath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
    const areaPath = linePath + ` L${(PAD + (pts.length - 1) * xStep).toFixed(2)},${H - PAD} L${PAD},${H - PAD} Z`;
    el.innerHTML = `
      <path d="${areaPath}" fill="currentColor" fill-opacity="0.15" stroke="none"/>
      <path d="${linePath}" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
    `;
    el.setAttribute(
      "aria-label",
      `Sessions per day, last ${pts.length} day${pts.length === 1 ? "" : "s"}; peak ${max}`,
    );
  } catch {
    /* sparkline is decorative — don't surface errors */
  }
}

document.querySelectorAll(".detail-tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => renderDetailTab(btn.dataset.tab));
});

detailClose.addEventListener("click", () => {
  detailPanel.hidden = true;
  currentSession = null;
  currentDetail = null;
});

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  persist.set("searchQuery", q);
  runSearch(q);
});

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = searchInput.value.trim();
    persist.set("searchQuery", q);
    runSearch(q);
  }, 200);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !detailPanel.hidden) {
    detailPanel.hidden = true;
    currentSession = null;
    currentDetail = null;
    searchInput.focus();
  }
});

// Restore filter chip state from localStorage before first fetch so the
// initial loadRecent() call honors persisted filters.
for (const b of document.querySelectorAll(".filters .chip[data-client]")) {
  b.setAttribute("aria-pressed", String((b.dataset.client || "") === activeClient));
}
const recentToggle = document.getElementById("recent-toggle");
if (recentToggle) recentToggle.setAttribute("aria-pressed", String(recentMode));
const restoredQuery = persist.get("searchQuery", "");
if (restoredQuery) searchInput.value = restoredQuery;

connectFeed();
pollStatus();
setInterval(pollStatus, 5000);
loadCategoryChips();
loadSparkline();
// Refresh sparkline + chip counts every 60s so the topbar reflects new
// indexing activity. Cheap (two small SELECTs) and avoids flicker.
setInterval(() => {
  loadSparkline();
  loadCategoryChips();
}, 60_000);

if (restoredQuery) runSearch(restoredQuery);
else loadRecent();
