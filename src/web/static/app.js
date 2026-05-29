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

// Live strip: streams tool_call + file_touch events from SSE. Kept separate
// from the legacy #feed list (which still drives the "+N new" badge) so the
// dashboard can render them with distinct styling and capacity.
const MAX_LIVE_ROWS = 200;
const liveFeed = document.getElementById("live-strip-feed");
const liveStatus = document.getElementById("live-strip-status");
const liveClear = document.getElementById("live-strip-clear");
let liveCount = 0;
function fmtClockTime(iso) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return isNaN(d) ? "--:--:--" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function shortPath(p) {
  if (!p) return "";
  const home = "/Users/";
  const idx = p.indexOf(home);
  if (idx >= 0) {
    const tail = p.slice(idx + home.length);
    const slash = tail.indexOf("/");
    return slash >= 0 ? "~/" + tail.slice(slash + 1) : "~/" + tail;
  }
  return p;
}
// Pull a meaningful one-line hint out of a tool_call's stored input_json.
// Shape varies by client; we only handle the common Anthropic/Codex/Gemini
// shapes and fall back to nothing on parse failure.
function toolHint(toolName, inputJson) {
  if (!inputJson) return "";
  let args;
  try { args = JSON.parse(inputJson); } catch { return ""; }
  if (!args || typeof args !== "object") return "";
  const cmd = args.command || args.cmd;
  if (cmd && typeof cmd === "string") return cmd.replace(/\s+/g, " ").slice(0, 80);
  const fp = args.file_path || args.path || args.filePath;
  if (fp && typeof fp === "string") return fp.split("/").pop();
  if (typeof args.query === "string") return args.query.slice(0, 80);
  if (typeof args.pattern === "string") return args.pattern.slice(0, 80);
  // Script-eval style tools: serval evaluate_js, etc.
  const code = args.script || args.expression || args.code;
  if (typeof code === "string") return code.replace(/\s+/g, " ").slice(0, 80);
  if (typeof args.description === "string") return args.description.slice(0, 80);
  if (typeof args.url === "string") return args.url.slice(0, 80);
  return "";
}
function projectLabel(projectPath) {
  if (!projectPath) return "";
  return projectPath.split("/").filter(Boolean).pop() || "";
}
function appendLiveRow(kind, ev) {
  if (!liveFeed) return;
  const row = document.createElement("li");
  row.dataset.kind = kind;
  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = fmtClockTime(ev.timestamp);
  const k = document.createElement("span");
  k.className = "kind";
  k.textContent = kind === "tool_call" ? ev.tool_name || "tool" : ev.operation || "edit";
  const body = document.createElement("span");
  body.className = "body";
  const proj = projectLabel(ev.project_path);
  if (kind === "tool_call") {
    const hint = toolHint(ev.tool_name, ev.input_json);
    body.textContent = proj && hint ? `${proj} · ${hint}` : (hint || proj || `[${(ev.session_id || "").slice(0, 8)}]`);
    body.title = ev.input_json || ev.session_id || "";
  } else {
    body.textContent = proj
      ? `${proj} · ${shortPath(ev.file_path)}`
      : shortPath(ev.file_path);
    body.title = ev.file_path || "";
  }
  row.append(ts, k, body);
  liveFeed.prepend(row);
  while (liveFeed.children.length > MAX_LIVE_ROWS) liveFeed.lastElementChild.remove();
  liveCount += 1;
  if (liveStatus) liveStatus.textContent = `${liveCount} events`;
}
if (liveClear) {
  liveClear.addEventListener("click", () => {
    if (liveFeed) liveFeed.innerHTML = "";
    liveCount = 0;
    if (liveStatus) liveStatus.textContent = "cleared";
  });
}

// The feed pill doubles as the visibility toggle for the live strip:
// pressed=visible (highlighted), unpressed=hidden. State persists; the
// inline script in index.html applies it before first paint.
(() => {
  const pill = document.getElementById("feed-pill");
  if (!pill) return;
  const sync = () => {
    const hidden = !!document.documentElement.dataset.liveHidden;
    pill.setAttribute("aria-pressed", String(!hidden));
  };
  sync();
  pill.addEventListener("click", () => {
    if (document.documentElement.dataset.liveHidden) {
      delete document.documentElement.dataset.liveHidden;
      try { localStorage.removeItem("momento.ui.liveHidden"); } catch { /* ignore */ }
    } else {
      document.documentElement.dataset.liveHidden = "1";
      persist.set("liveHidden", "1");
    }
    sync();
  });
})();

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
  es.addEventListener("tool_call", (e) => {
    try { appendLiveRow("tool_call", JSON.parse(e.data)); } catch {}
  });
  es.addEventListener("file_touch", (e) => {
    try { appendLiveRow("file_touch", JSON.parse(e.data)); } catch {}
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
    uptimePill.textContent = `uptime: ${fmtUptime(j.uptime_seconds)}`;
    countPill.textContent = `sessions: ${j.session_count}`;
    dbPathEl.textContent = `db: ${j.db_path} (${formatBytes(j.db_size_bytes)})`;
  } catch {
    // feed pill already surfaces connection issues
  }
}

function fmtUptime(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
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
  // Fixed cell size across all scopes so the grid's density stays consistent
  // when switching between 14d / 30d / 90d / all.
  const CELL = 8, GAP = 3;
  const W = weeks * (CELL + GAP) + GAP;
  const H = 7 * (CELL + GAP) + GAP;
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

// Theme picker. Persisted theme is already applied to <html data-theme=...>
// by an inline script in index.html before first paint; this block only
// keeps the dropdown's selection in sync and writes future changes back.
(() => {
  const sel = document.getElementById("theme-select");
  if (!sel) return;
  const current = document.documentElement.dataset.theme || "";
  sel.value = current;
  sel.addEventListener("change", () => {
    const value = sel.value;
    if (value) {
      document.documentElement.dataset.theme = value;
      persist.set("theme", value);
    } else {
      delete document.documentElement.dataset.theme;
      try { localStorage.removeItem("momento.ui.theme"); } catch { /* ignore */ }
    }
  });
})();

// Live strip resize handle. Drag the bottom edge to grow/shrink the feed
// pane; height persists to localStorage and is re-applied pre-paint by the
// inline script in index.html so reloads don't snap back to default.
(() => {
  const strip = document.querySelector(".live-strip");
  const handle = document.getElementById("live-resize");
  if (!strip || !handle) return;
  const MIN = 60;
  const clampMax = () => Math.max(MIN + 40, Math.floor(window.innerHeight * 0.7));
  const apply = (px) => {
    const v = Math.min(clampMax(), Math.max(MIN, px));
    document.documentElement.style.setProperty("--live-height", v + "px");
    persist.set("liveHeight", String(v));
  };
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing");
    const top = strip.getBoundingClientRect().top;
    const onMove = (ev) => apply(ev.clientY - top);
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = strip.getBoundingClientRect().height;
    const step = e.shiftKey ? 60 : 16;
    apply(cur + (e.key === "ArrowDown" ? step : -step));
  });
})();

// Detail panel resize handle. Drag updates the --detail-height CSS var on
// the dashboard grid; value is clamped against viewport height and persisted
// so reloads keep the user's preferred split.
(() => {
  const grid = document.querySelector(".dashboard .grid");
  const handle = document.getElementById("detail-resize");
  if (!grid || !handle) return;
  const MIN = 120;
  const restored = parseInt(persist.get("detailHeight", ""), 10);
  if (Number.isFinite(restored) && restored >= MIN) {
    grid.style.setProperty("--detail-height", restored + "px");
  }
  const clampMax = () => Math.max(MIN + 40, window.innerHeight - 200);
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing");
    const onMove = (ev) => {
      const next = Math.min(clampMax(), Math.max(MIN, window.innerHeight - ev.clientY - 24));
      grid.style.setProperty("--detail-height", next + "px");
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      const cur = grid.style.getPropertyValue("--detail-height").trim();
      if (cur) persist.set("detailHeight", parseInt(cur, 10).toString());
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = parseInt(grid.style.getPropertyValue("--detail-height"), 10)
      || Math.round(window.innerHeight * 0.4);
    const step = e.shiftKey ? 60 : 16;
    const next = Math.min(clampMax(), Math.max(MIN, cur + (e.key === "ArrowUp" ? step : -step)));
    grid.style.setProperty("--detail-height", next + "px");
    persist.set("detailHeight", next.toString());
  });
})();

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
