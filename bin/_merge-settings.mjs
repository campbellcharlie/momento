// Internal helper for bin/momento-install. Reads env vars, emits the merged
// settings.json on stdout. Kept as a separate file because embedding it as a
// here-doc inside $() in bash confuses the bash parser on parentheses in JS.
//
// Env contract:
//   SETTINGS_PATH  absolute path to ~/.claude/settings.json (or override)
//   SERVER_JS      absolute path to momento's dist/server.js
//   CLI_JS         absolute path to momento's dist/cli.js
//   INSTALL_HOOK   "1" to write the UserPromptSubmit hook, else skip
//   INSTALL_MCP    "1" to write the mcpServers entry, else skip
//
// Exits 1 with a message on stderr if settings.json exists but isn't JSON.

import fs from "node:fs";

const settingsPath = process.env.SETTINGS_PATH;
const serverJs = process.env.SERVER_JS;
const cliJs = process.env.CLI_JS;
const installHook = process.env.INSTALL_HOOK === "1";
const installMcp = process.env.INSTALL_MCP === "1";

let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, "utf8").trim();
  if (raw) {
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(
        `momento-install: ${settingsPath} is not valid JSON: ${e.message}\n`,
      );
      process.exit(1);
    }
  }
}

const hookCmd = `node ${cliJs}`;

if (installMcp) {
  settings.mcpServers = settings.mcpServers || {};
  // Replace any prior 'momento' MCP entry — args may have moved with a re-clone.
  // Other MCP servers stay untouched.
  settings.mcpServers.momento = { command: "node", args: [serverJs] };
}

if (installHook) {
  settings.hooks = settings.hooks || {};
  const arr = Array.isArray(settings.hooks.UserPromptSubmit)
    ? settings.hooks.UserPromptSubmit
    : [];
  // Dedupe by exact command match OR by any prior entry that points at a
  // dist/cli.js anywhere with 'momento' in the path (so renaming the install
  // dir doesn't leave a stale entry pointing at a deleted binary). Other
  // tools' hooks stay untouched.
  const isMomentoHook = (h) => {
    if (!h || typeof h !== "object") return false;
    const c = typeof h.command === "string" ? h.command : "";
    if (c === hookCmd) return true;
    return c.includes("momento") && /\/dist\/cli\.js\b/.test(c);
  };
  const filtered = arr.filter((h) => !isMomentoHook(h));
  filtered.push({ command: hookCmd });
  settings.hooks.UserPromptSubmit = filtered;
}

process.stdout.write(JSON.stringify(settings, null, 2) + "\n");
