// Shell shims that ship with ae. Installed to $BIN_DIR so users get `cc`,
// `cct`, `cs`, `cx`, `ccbg` on PATH automatically — no shell-rc mutation.
//
// Each entry mirrors an alias from the user's zshrc. Adding a file to
// cli/shims/ and registering it here is enough to roll out a new one.

import { resolve } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type Shim = {
  name: string;
  summary: string;
  underlying: string; // what the shim execs (for --help output)
};

export const SHIMS: Shim[] = [
  { name: "cc",   summary: "Fast Claude Code (dangerous-skip-permissions)",           underlying: "claude --dangerously-skip-permissions" },
  { name: "cct",  summary: "Claude teams via cmux",                                    underlying: "cmux claude-teams --dangerously-skip-permissions" },
  { name: "cs",   summary: "agent (Codex-style) in yolo mode",                         underlying: "agent --yolo" },
  { name: "cx",   summary: "Codex with approvals + sandbox bypassed",                  underlying: "codex --dangerously-bypass-approvals-and-sandbox" },
  { name: "ccbg", summary: "Background a command, tee its output to /tmp/ccbg/",      underlying: "bash shim — see cli/shims/ccbg" },
];

export function shimsDir(): string {
  const self = realpathSync(import.meta.url.replace(/^file:\/\//, ""));
  // this file: <cli>/src/shims.ts  →  <cli>/shims/
  return resolve(dirname(self), "..", "shims");
}

export function shimPath(name: string): string | null {
  const p = resolve(shimsDir(), name);
  return existsSync(p) ? p : null;
}
