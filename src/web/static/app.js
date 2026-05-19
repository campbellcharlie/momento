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
// Dashboard scope: drives the activity heatmap range AND the session list
// filter. `scopeDays` is the heatmap window; `scopeDay` is an optional
// exact-day filter (set when the user clicks a heatmap cell). Both persist.
const SCOPE_DAYS_BY_LABEL = { "14d": 14, "30d": 30, "90d": 90, "all": 730 };
let scopeRangeLabel = persist.get("scopeRange", "14d");
if (!(scopeRangeLabel in SCOPE_DAYS_BY_LABEL)) scopeRangeLabel = "14d";
let scopeDay = persist.get("scopeDay", "");
// scopeRepo: a bucketed repo path (e.g. "/Volumes/.../src/momento"). Set by
// clicking a lane in the Repos panel; intersects with all other filters.
let scopeRepo = persist.get("scopeRepo", "");
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

// Live-feed sessions land in the hidden #feed list (preserved from the
// pre-dashboard layout so SSE wiring keeps working) and bump the topbar
// "+N new" badge. Clicking the badge re-fetches the recent list with the
// current scope and resets the counter.
let newSessionsSeen = new Set();
const newBadge = document.getElementById("new-sessions-badge");
function appendFeedRow(ev) {
  if (paused) return;
  feedEmpty.hidden = true;
  feed.hidden = false;
  const row = document.createElement("li");
  row.className = "event-row";
  row.dataset.id = String(ev.id);
  row.dataset.sessionId = ev.session_id;
  feed.prepend(row);
  while (feed.children.length > MAX_FEED_ROWS) feed.lastElementChild.remove();
  // Topbar badge: increment unless the session is already in the visible
  // list (e.g. our own active session re-indexing). Hidden until count > 0.
  if (!newSessionsSeen.has(ev.session_id)) {
    newSessionsSeen.add(ev.session_id);
    if (newBadge) {
      newBadge.hidden = false;
      newBadge.textContent = `+${newSessionsSeen.size} new`;
    }
  }
}

if (newBadge) {
  newBadge.addEventListener("click", () => {
    newSessionsSeen.clear();
    newBadge.hidden = true;
    newBadge.textContent = "+0 new";
    const q = searchInput.value.trim();
    if (q) runSearch(q);
    else loadRecent();
    // Also nudge the heatmap so the new day shows up
    loadHeatmap();
  });
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
    if (scopeDay) params.set("day", scopeDay);
    if (scopeRepo) params.set("repo", scopeRepo);
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
    if (scopeRepo) params.set("repo", scopeRepo);
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
  // Remove any prior shape bar so we don't show stale data while loading.
  const oldShape = document.getElementById("detail-shape");
  if (oldShape) oldShape.remove();
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
    renderDetailShape(sessionId);
    renderDetailTab(currentTab);
    detailTitle.focus?.();
  } catch (err) {
    detailMeta.textContent = `Could not load session: ${err.message}`;
  }
}

// Stacked-bar visualization of one session's category mix, rendered into
// the detail rail. Uses session_category_breakdown surface — same SQL as
// the MCP tool of the same name. Each segment is proportional to that
// category's turn count. Hover shows category + count via title attr.
async function renderDetailShape(sessionId) {
  // The MCP tool exists; the web layer doesn't expose it as its own route
  // yet. Reach into the same SQL by riding /api/sessions/:id detail (which
  // doesn't include it) and falling back to a small inline aggregate over
  // the messages we already have. Add a dedicated route later if this gets
  // heavy use.
  //
  // For now: hit a small new endpoint added in this draft.
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/categories`);
    if (!r.ok) return;
    const j = await r.json();
    const breakdown = Array.isArray(j.breakdown) ? j.breakdown : [];
    if (breakdown.length === 0) return;
    const total = breakdown.reduce((s, b) => s + b.turns, 0);
    if (total === 0) return;
    const wrap = document.createElement("div");
    wrap.id = "detail-shape";
    wrap.className = "detail-shape";
    const bar = document.createElement("div");
    bar.className = "detail-shape-bar";
    const legend = document.createElement("ul");
    legend.className = "detail-shape-legend";
    for (const b of breakdown) {
      const seg = document.createElement("span");
      seg.className = "detail-shape-seg";
      seg.dataset.category = b.category;
      seg.style.flexGrow = String(b.turns);
      seg.title = `${b.category}: ${b.turns} turn${b.turns === 1 ? "" : "s"}`;
      bar.appendChild(seg);

      const li = document.createElement("li");
      li.dataset.category = b.category;
      li.innerHTML = `<span class="legend-swatch"></span><span>${escapeHtml(b.category)}</span><span class="legend-count">${b.turns}</span>`;
      legend.appendChild(li);
    }
    wrap.append(bar, legend);
    detailMeta.after(wrap);
  } catch {
    /* shape is decorative; never break detail load */
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

// Category state. Draft 5 removed the chip row in the Sessions panel — the
// Categories panel is now the canonical UI for setting activeCategory.
// Lane-click handler in loadCategoryLanes() calls this; scope-summary
// pills (below) call it with "" to clear.
function setActiveCategory(value) {
  activeCategory = value;
  persist.set("activeCategory", value);
  // Sync category-lane selection state if the panel is already rendered.
  for (const l of document.querySelectorAll("#categories-canvas .lane")) {
    if (value && l.dataset.category === value) l.setAttribute("data-selected", "1");
    else l.removeAttribute("data-selected");
  }
  renderScopeSummary();
}

document.getElementById("recent-toggle").addEventListener("click", (e) => {
  recentMode = !recentMode;
  persist.set("recentMode", recentMode ? "1" : "0");
  e.currentTarget.setAttribute("aria-pressed", String(recentMode));
  const q = searchInput.value.trim();
  if (!q && recentMode) loadRecent();
  if (!recentMode && !q) { searchResults.innerHTML = ""; searchStatus.textContent = ""; }
});

// Calendar-style activity heatmap. GitHub-contribution-graph layout: each
// column = one week, each row = one weekday (Sun-Sat). Cells colored by
// session count, bucketed into 5 intensity steps. Click a cell to scope the
// session list to that single day; click the same cell again (or "All" in
// the topbar) to clear the day filter.
//
// Vanilla SVG so it inherits the existing zero-deps frontend posture.
async function loadHeatmap() {
  const canvas = document.getElementById("activity-canvas");
  if (!canvas) return;
  const days = SCOPE_DAYS_BY_LABEL[scopeRangeLabel] || 14;
  let pts;
  try {
    const r = await fetch(`/api/activity?days=${days}`);
    if (!r.ok) return;
    const j = await r.json();
    pts = Array.isArray(j.points) ? j.points : [];
  } catch {
    return; // heatmap is recoverable; just leave the previous render
  }
  // Build a date → count map for O(1) lookup while we walk the calendar grid.
  const counts = new Map(pts.map((p) => [p.day, p.n]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Anchor the rightmost column on the week containing `today`. Walk back
  // `days` days from today; align to Sunday so weeks render as clean
  // columns. Each cell stores its YYYY-MM-DD key in data-day.
  const start = new Date(today.getTime() - (days - 1) * 86400000);
  // Move start back to the nearest prior Sunday so the grid starts on a
  // week boundary.
  start.setDate(start.getDate() - start.getDay());
  const totalDays = Math.ceil((today.getTime() - start.getTime()) / 86400000) + 1;
  const weeks = Math.ceil(totalDays / 7);
  const max = pts.reduce((m, p) => (p.n > m ? p.n : m), 0);
  // Bucket thresholds — relative to the visible max so a quiet week still
  // shows variation. With max < 1, all cells are empty.
  const bucket = (n) => {
    if (!n || max === 0) return 0;
    const r = n / max;
    if (r >= 0.75) return 4;
    if (r >= 0.5) return 3;
    if (r >= 0.25) return 2;
    return 1;
  };
  const CELL = 12, GAP = 3;
  const W = weeks * (CELL + GAP) + GAP;
  const H = 7 * (CELL + GAP) + GAP;
  // Render at native pixel size — the heatmap is meant to be 12px-per-day
  // dense, not stretched to fill the panel. CSS `width:auto` + the explicit
  // width/height attributes keep cells pixel-perfect regardless of panel
  // size; the panel scrolls horizontally if weeks exceed the viewport.
  const parts = [`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="heatmap-svg" aria-label="Sessions per day, last ${days} days; peak ${max}">`];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const dayDate = new Date(start.getTime() + (w * 7 + d) * 86400000);
      if (dayDate > today) continue; // future cells stay blank
      const iso = isoDate(dayDate);
      const n = counts.get(iso) || 0;
      const x = GAP + w * (CELL + GAP);
      const y = GAP + d * (CELL + GAP);
      const b = bucket(n);
      const selected = scopeDay === iso ? " data-selected=\"1\"" : "";
      parts.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" ry="2" class="heatmap-cell" data-day="${iso}" data-bucket="${b}" data-count="${n}"${selected}><title>${iso}: ${n} session${n === 1 ? "" : "s"}</title></rect>`,
      );
    }
  }
  parts.push("</svg>");
  canvas.innerHTML = parts.join("");
  // Summary text in the header: total sessions in the visible window + the
  // selected-day scope when applicable.
  const totalInWindow = pts.reduce((s, p) => s + p.n, 0);
  const summary = document.getElementById("activity-summary");
  if (summary) {
    summary.textContent = scopeDay
      ? `${totalInWindow} sessions in ${days}d  ·  filtered to ${scopeDay}`
      : `${totalInWindow} sessions in ${days}d  ·  peak ${max}/day`;
  }
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function setScopeDay(iso) {
  if (scopeDay === iso) iso = ""; // second click on same cell clears filter
  scopeDay = iso;
  persist.set("scopeDay", scopeDay);
  // Re-render heatmap so the selected cell shows the highlight, and refetch
  // the session list with the new filter.
  loadHeatmap();
  renderScopeSummary();
  const q = searchInput.value.trim();
  if (q) runSearch(q);
  else loadRecent();
}

// Active filter summary above the result list. One pill per non-default
// scope dimension; each pill has an × button to clear that dimension.
// Hidden when nothing's filtered. Replaces the old category-chip row.
function renderScopeSummary() {
  const el = document.getElementById("scope-summary");
  if (!el) return;
  const pills = [];
  if (scopeDay) pills.push({ key: "day", label: `day: ${scopeDay}` });
  if (scopeRepo) {
    const name = scopeRepo.split("/").pop() || scopeRepo;
    pills.push({ key: "repo", label: `repo: ${name}` });
  }
  if (activeCategory) pills.push({ key: "category", label: `category: ${activeCategory}` });
  if (pills.length === 0) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  const parts = [];
  for (const p of pills) {
    parts.push(
      `<span class="scope-pill" data-scope-key="${p.key}">`,
      `<span>${escapeHtml(p.label)}</span>`,
      `<button type="button" class="scope-pill-clear" data-scope-key="${p.key}" aria-label="Clear ${p.key} filter">×</button>`,
      `</span>`,
    );
  }
  parts.push(
    `<button type="button" class="scope-pill scope-pill-clear-all" data-scope-key="all">clear all</button>`,
  );
  el.innerHTML = parts.join("");
}

document.getElementById("scope-summary").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-scope-key]");
  if (!btn) return;
  const key = btn.dataset.scopeKey;
  if (key === "day" || key === "all") setScopeDay("");
  if (key === "repo" || key === "all") setScopeRepo("");
  if (key === "category" || key === "all") {
    setActiveCategory("");
    const q = searchInput.value.trim();
    if (q) runSearch(q);
    else loadRecent();
  }
});

function setScopeRange(label) {
  if (!(label in SCOPE_DAYS_BY_LABEL)) return;
  scopeRangeLabel = label;
  persist.set("scopeRange", label);
  for (const b of document.querySelectorAll(".topbar-scope .chip[data-scope]")) {
    b.setAttribute("aria-pressed", String(b.dataset.scope === label));
  }
  loadHeatmap();
}

// Topbar scope chips
document.querySelectorAll(".topbar-scope .chip[data-scope]").forEach((btn) => {
  btn.addEventListener("click", () => setScopeRange(btn.dataset.scope));
});

// Click delegation for heatmap cells
document.getElementById("activity-canvas").addEventListener("click", (e) => {
  const cell = e.target.closest(".heatmap-cell");
  if (!cell) return;
  setScopeDay(cell.dataset.day);
});

// Repo lanes: one row per top-edited repo bucket, with a bar showing the
// session count relative to the most-active repo. Click a lane to filter
// the session list to that repo; click the active lane again to clear.
async function loadRepoLanes() {
  const canvas = document.getElementById("repos-canvas");
  if (!canvas) return;
  let repos;
  try {
    const r = await fetch("/api/repos?limit=12");
    if (!r.ok) return;
    const j = await r.json();
    repos = Array.isArray(j.repos) ? j.repos : [];
  } catch {
    return;
  }
  if (repos.length === 0) {
    canvas.innerHTML = `<p class="stub">no repo activity indexed yet</p>`;
    return;
  }
  const max = Math.max(...repos.map((r) => r.sessions), 1);
  const lines = ['<ul class="lane-list">'];
  for (const r of repos) {
    const name = r.repo.split("/").pop() || r.repo;
    const pct = Math.max(2, Math.round((r.sessions / max) * 100));
    const selected = scopeRepo === r.repo ? ' data-selected="1"' : "";
    lines.push(
      `<li class="lane" data-repo="${escapeAttr(r.repo)}"${selected} title="${escapeAttr(r.repo)} — last active ${(r.lastModified || "").slice(0, 10)}">`,
      `<span class="lane-name">${escapeHtml(name)}</span>`,
      `<span class="lane-bar"><span class="lane-bar-fill" style="width:${pct}%"></span></span>`,
      `<span class="lane-count">${r.sessions}</span>`,
      `</li>`,
    );
  }
  lines.push("</ul>");
  canvas.innerHTML = lines.join("");
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setScopeRepo(repo) {
  if (scopeRepo === repo) repo = ""; // toggle off
  scopeRepo = repo;
  persist.set("scopeRepo", scopeRepo);
  // Update lane visual state in-place rather than re-fetching the repo list.
  for (const lane of document.querySelectorAll("#repos-canvas .lane")) {
    if (scopeRepo && lane.dataset.repo === scopeRepo) lane.setAttribute("data-selected", "1");
    else lane.removeAttribute("data-selected");
  }
  renderScopeSummary();
  const q = searchInput.value.trim();
  if (q) runSearch(q);
  else loadRecent();
}

document.getElementById("repos-canvas").addEventListener("click", (e) => {
  const lane = e.target.closest(".lane[data-repo]");
  if (!lane) return;
  setScopeRepo(lane.dataset.repo);
});

// Categories panel: bar-per-category visualization. Same lane pattern as
// repos. Reuses the existing /api/categories route and the existing
// activeCategory state (managed by the Sessions panel chips), so clicking
// here keeps the chip row in the Sessions panel in sync.
async function loadCategoryLanes() {
  const canvas = document.getElementById("categories-canvas");
  if (!canvas) return;
  let cats;
  try {
    const r = await fetch("/api/categories");
    if (!r.ok) return;
    const j = await r.json();
    cats = Array.isArray(j.categories) ? j.categories : [];
  } catch {
    return;
  }
  if (cats.length === 0) {
    canvas.innerHTML = `<p class="stub">no categorized turns yet — run <code>momento --rebuild</code></p>`;
    return;
  }
  const max = Math.max(...cats.map((c) => c.sessions), 1);
  const lines = ['<ul class="lane-list">'];
  for (const c of cats) {
    const pct = Math.max(2, Math.round((c.sessions / max) * 100));
    const selected = activeCategory === c.category ? ' data-selected="1"' : "";
    lines.push(
      `<li class="lane lane-category" data-category="${escapeAttr(c.category)}"${selected} title="${c.turns} turns across ${c.sessions} sessions">`,
      `<span class="lane-name">${escapeHtml(c.category)}</span>`,
      `<span class="lane-bar"><span class="lane-bar-fill" style="width:${pct}%"></span></span>`,
      `<span class="lane-count">${c.sessions}</span>`,
      `</li>`,
    );
  }
  lines.push("</ul>");
  canvas.innerHTML = lines.join("");
}

// Clicking a category lane sets activeCategory and mirrors the change into
// the existing chip row in the Sessions panel so both surfaces agree.
document.getElementById("categories-canvas").addEventListener("click", (e) => {
  const lane = e.target.closest(".lane[data-category]");
  if (!lane) return;
  const next = activeCategory === lane.dataset.category ? "" : lane.dataset.category;
  setActiveCategory(next);
  for (const l of document.querySelectorAll("#categories-canvas .lane")) {
    if (next && l.dataset.category === next) l.setAttribute("data-selected", "1");
    else l.removeAttribute("data-selected");
  }
  const q = searchInput.value.trim();
  if (q) runSearch(q);
  else loadRecent();
});

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

// Reflect persisted scope range in the topbar chips before the first
// heatmap render so the right chip lights up.
for (const b of document.querySelectorAll(".topbar-scope .chip[data-scope]")) {
  b.setAttribute("aria-pressed", String(b.dataset.scope === scopeRangeLabel));
}

connectFeed();
pollStatus();
setInterval(pollStatus, 5000);
loadCategoryLanes();
loadHeatmap();
loadRepoLanes();
renderScopeSummary();
// Refresh viz panels every 60s so they reflect new indexing activity.
setInterval(() => {
  loadHeatmap();
  loadCategoryLanes();
  loadRepoLanes();
}, 60_000);

if (restoredQuery) runSearch(restoredQuery);
else loadRecent();
