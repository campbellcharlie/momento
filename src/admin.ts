import { rmSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Indexer } from "./indexer.js";
import { loadConfig, type Rule } from "./config.js";

export interface AdminPaths {
  dbDir: string;
  dbPath: string;
  projectsRoot: string;
  ignoreFile: string;
}

export function defaultPaths(): AdminPaths {
  const home = homedir();
  return {
    dbDir: join(home, ".momento"),
    dbPath: join(home, ".momento", "index.db"),
    projectsRoot: join(home, ".claude", "projects"),
    ignoreFile: join(home, ".momentoignore"),
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

export async function runRebuild(paths: AdminPaths = defaultPaths()): Promise<void> {
  // Wipe DB + WAL/SHM sidecars and rebuild from scratch. Safer than expecting users
  // to delete the right files by hand.
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = paths.dbPath + suffix;
    if (existsSync(p)) rmSync(p, { force: true });
  }
  process.stdout.write(`momento: rebuilding ${paths.dbPath} from ${paths.projectsRoot}\n`);
  const cfg = loadConfig({ ignoreFile: paths.ignoreFile });
  const indexer = new Indexer(paths.dbPath, cfg);
  let last = 0;
  await indexer.buildAll(paths.projectsRoot, ({ done }) => {
    if (done - last >= 25) {
      process.stdout.write(`  indexed ${done} sessions\n`);
      last = done;
    }
  });
  const count = (indexer.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
  indexer.close();
  process.stdout.write(`momento: rebuild complete — ${count} sessions, db ${fmtBytes(fileSize(paths.dbPath))}\n`);
}

export function runStatus(paths: AdminPaths = defaultPaths()): void {
  if (!existsSync(paths.dbPath)) {
    process.stdout.write(`momento: no index at ${paths.dbPath} (run \`momento --rebuild\`)\n`);
    return;
  }
  const cfg = loadConfig({ ignoreFile: paths.ignoreFile });
  const indexer = new Indexer(paths.dbPath, cfg);
  try {
    const sessions = indexer.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    const messages = indexer.db.prepare(`SELECT COUNT(*) AS n FROM messages_fts`).get() as { n: number };
    const touches = indexer.db.prepare(`SELECT COUNT(*) AS n FROM file_touches`).get() as { n: number };
    const tools = indexer.db.prepare(`SELECT COUNT(*) AS n FROM tool_calls`).get() as { n: number };
    const newest = indexer.db
      .prepare(`SELECT modified FROM sessions ORDER BY modified DESC LIMIT 1`)
      .get() as { modified: string } | undefined;
    const oldest = indexer.db
      .prepare(`SELECT modified FROM sessions ORDER BY modified ASC LIMIT 1`)
      .get() as { modified: string } | undefined;
    const lines = [
      `momento status`,
      `  db:               ${paths.dbPath} (${fmtBytes(fileSize(paths.dbPath))})`,
      `  projects root:    ${paths.projectsRoot}`,
      `  sessions:         ${sessions.n}`,
      `  messages indexed: ${messages.n}`,
      `  tool calls:       ${tools.n}`,
      `  file touches:     ${touches.n}`,
      `  newest session:   ${newest?.modified ?? "(none)"}`,
      `  oldest session:   ${oldest?.modified ?? "(none)"}`,
      `  index thinking:   ${cfg.indexThinking ? "yes" : "no (default)"}`,
      `  exclude projects: ${cfg.rawProjectPatterns.length ? cfg.rawProjectPatterns.join(", ") : "(none)"}`,
      `  exclude paths:    ${cfg.rawPathPatterns.length ? cfg.rawPathPatterns.join(", ") : "(none)"}`,
    ];
    if (cfg.rawProjectPatterns.length || cfg.rawPathPatterns.length) {
      lines.push(`  note: exclusions only apply to new/changed sessions; run \`momento --rebuild\` after editing them.`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    indexer.close();
  }
}

export function runDoctor(paths: AdminPaths = defaultPaths()): number {
  // Returns process exit code: 0 healthy, 1 has warnings, 2 broken.
  let warn = 0;
  let fail = 0;
  const out: string[] = [];
  const ok = (m: string) => out.push(`  ok    ${m}`);
  const wrn = (m: string) => {
    warn++;
    out.push(`  warn  ${m}`);
  };
  const bad = (m: string) => {
    fail++;
    out.push(`  FAIL  ${m}`);
  };

  out.push("momento doctor");

  // Node version. node:sqlite is stable in 24+, flag-gated in 22.
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 24) ok(`node ${process.versions.node} (built-in sqlite)`);
  else if (nodeMajor === 22) wrn(`node ${process.versions.node} works only with --experimental-sqlite; recommend node 24+`);
  else bad(`node ${process.versions.node} too old; need 22+ (24+ recommended)`);

  // Projects directory existence — momento has nothing to index without it.
  if (existsSync(paths.projectsRoot)) {
    try {
      const st = statSync(paths.projectsRoot);
      if (st.isDirectory()) ok(`projects root ${paths.projectsRoot}`);
      else bad(`projects root ${paths.projectsRoot} is not a directory`);
    } catch (err) {
      bad(`projects root ${paths.projectsRoot}: ${(err as Error).message}`);
    }
  } else {
    bad(`projects root not found: ${paths.projectsRoot} — is Claude Code installed?`);
  }

  // DB writability check.
  if (existsSync(paths.dbPath)) {
    ok(`db present (${fmtBytes(fileSize(paths.dbPath))})`);
    try {
      const cfg = loadConfig({ ignoreFile: paths.ignoreFile });
      const indexer = new Indexer(paths.dbPath, cfg);
      try {
        const n = (indexer.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
        if (n === 0) wrn(`db has 0 sessions (run \`momento --rebuild\`)`);
        else ok(`db has ${n} sessions`);
      } finally {
        indexer.close();
      }
    } catch (err) {
      bad(`cannot open db: ${(err as Error).message}`);
    }
  } else {
    wrn(`no db yet at ${paths.dbPath} (run \`momento --rebuild\`)`);
  }

  // MOMENTO_SRC_ROOTS is only consulted by query-time bucketing, but warn if
  // it's set to an unreadable path — easy footgun.
  const roots = process.env.MOMENTO_SRC_ROOTS;
  if (roots) {
    for (const r of roots.split(":").filter(Boolean)) {
      if (!existsSync(r)) wrn(`MOMENTO_SRC_ROOTS entry not found: ${r}`);
    }
  }

  // Ignore file feedback.
  const cfg = loadConfig({ ignoreFile: paths.ignoreFile });
  if (existsSync(paths.ignoreFile)) ok(`ignore file ${paths.ignoreFile}`);
  if (cfg.indexThinking) wrn(`MOMENTO_INDEX_THINKING is on — assistant thinking blocks are being indexed`);

  process.stdout.write(out.join("\n") + "\n");
  if (fail > 0) {
    process.stdout.write(`\n${fail} failure(s), ${warn} warning(s)\n`);
    return 2;
  }
  if (warn > 0) {
    process.stdout.write(`\n${warn} warning(s)\n`);
    return 1;
  }
  process.stdout.write(`\nall good\n`);
  return 0;
}

function listRules(label: string, rules: Rule[]): string[] {
  if (rules.length === 0) return [`${label}: (none)`];
  const out = [`${label} (${rules.length}):`];
  const w = Math.max(...rules.map((r) => r.raw.length));
  for (const r of rules) {
    out.push(`  ${r.raw.padEnd(w)}  [${r.source}]`);
  }
  return out;
}

function traceRules(rules: Rule[], target: string): { lines: string[]; excluded: boolean } {
  const lines: string[] = [];
  let excluded = false;
  let lastIdx = -1;
  const w = rules.length ? Math.max(...rules.map((r) => r.raw.length)) : 0;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const hit = r.test(target);
    if (hit) {
      excluded = !r.negate;
      lastIdx = i;
      lines.push(
        `  ${r.raw.padEnd(w)}  ${r.negate ? "RE-INCLUDE" : "EXCLUDE   "}  [${r.source}]`,
      );
    } else {
      lines.push(`  ${r.raw.padEnd(w)}  (no match)`);
    }
  }
  if (lastIdx >= 0) {
    lines.push(`  → ${excluded ? "EXCLUDED" : "re-included"} by rule ${lastIdx + 1}`);
  } else if (rules.length > 0) {
    lines.push(`  → no rule matched`);
  }
  return { lines, excluded };
}

// Print which exclusion rules are loaded, where they came from, and (if a
// path is given) trace the rule chain against it. Returns a process exit code:
// 0 = no exclusion / no trace target; 1 = trace target would be excluded.
export function runExplainExclusions(
  paths: AdminPaths = defaultPaths(),
  target?: string,
): number {
  const cfg = loadConfig({ ignoreFile: paths.ignoreFile });
  const out: string[] = [];
  out.push(...listRules("exclude projects", cfg.excludeProjects));
  out.push("");
  out.push(...listRules("exclude paths", cfg.excludePaths));

  if (!target) {
    out.push("");
    out.push("Pass a path to trace which rules apply, e.g.:");
    out.push("  momento --explain-exclusions /Users/you/src/secrets/keys.env");
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  }

  out.push("");
  out.push(`trace for: ${target}`);
  out.push("");
  out.push("against project rules:");
  const proj = traceRules(cfg.excludeProjects, target);
  out.push(...(proj.lines.length ? proj.lines : ["  (no project rules configured)"]));
  out.push("");
  out.push("against path rules:");
  const path = traceRules(cfg.excludePaths, target);
  out.push(...(path.lines.length ? path.lines : ["  (no path rules configured)"]));
  out.push("");
  const excluded = proj.excluded || path.excluded;
  out.push(`verdict: ${excluded ? "EXCLUDED" : "indexed"}`);
  if (cfg.rawProjectPatterns.length || cfg.rawPathPatterns.length) {
    out.push("");
    out.push("note: exclusions are applied at index time. After editing them,");
    out.push("      run `momento --rebuild` to reprocess existing sessions.");
  }
  process.stdout.write(out.join("\n") + "\n");
  return excluded ? 1 : 0;
}
