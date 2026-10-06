// Internal helper for bin/momento-install --cursor. Merges momento into
// ~/.cursor/mcp.json and ~/.cursor/hooks.json.
//
// Env contract:
//   MCP_PATH       absolute path to ~/.cursor/mcp.json
//   HOOKS_PATH     absolute path to ~/.cursor/hooks.json
//   SERVER_JS      absolute path to momento's dist/server.js
//   CLI_JS         absolute path to momento's dist/cli.js
//   INSTALL_HOOK   "1" to write sessionStart hook, else skip
//   INSTALL_MCP    "1" to write the mcpServers entry, else skip
//
// Prints JSON to stdout:
//   { mcp: <object|null>, hooks: <object|null> }
// null means that file was not modified (install flag off).

import fs from "node:fs";

const mcpPath = process.env.MCP_PATH;
const hooksPath = process.env.HOOKS_PATH;
const serverJs = process.env.SERVER_JS;
const cliJs = process.env.CLI_JS;
const installHook = process.env.INSTALL_HOOK === "1";
const installMcp = process.env.INSTALL_MCP === "1";

function readJson(path) {
  if (!fs.existsSync(path)) return {};
  const raw = fs.readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`momento-install: ${path} is not valid JSON: ${e.message}\n`);
    process.exit(1);
  }
}

let mcp = null;
let hooks = null;

if (installMcp) {
  mcp = readJson(mcpPath);
  mcp.mcpServers = mcp.mcpServers || {};
  // Prefer going through marshal when the user already has it — don't duplicate
  // a direct momento entry beside an aggregating marshal fleet. Only install a
  // direct `momento` server when marshal is absent.
  if (!mcp.mcpServers.marshal) {
    mcp.mcpServers.momento = { command: "node", args: [serverJs] };
  }
}

if (installHook) {
  hooks = readJson(hooksPath);
  hooks.version = hooks.version ?? 1;
  hooks.hooks = hooks.hooks || {};
  const arr = Array.isArray(hooks.hooks.sessionStart) ? hooks.hooks.sessionStart : [];
  const hookCmd = `node ${cliJs}`;
  const isMomentoHook = (h) => {
    if (!h || typeof h !== "object") return false;
    const c = typeof h.command === "string" ? h.command : "";
    if (c === hookCmd) return true;
    return c.includes("momento") && /\/dist\/cli\.js\b/.test(c);
  };
  const filtered = arr.filter((h) => !isMomentoHook(h));
  // Absolute path: user hooks run with cwd ~/.cursor/, so a relative path to
  // dist/cli.js would miss. node + abs path is portable.
  filtered.push({ command: hookCmd });
  hooks.hooks.sessionStart = filtered;
}

process.stdout.write(JSON.stringify({ mcp, hooks }, null, 2) + "\n");
