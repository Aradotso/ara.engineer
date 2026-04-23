import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Canonical catalog lives at https://ara.engineer/mcp.json. We fetch it at
// runtime so updates don't need a CLI release. Fall back to a bundled copy
// if the network isn't available (offline dev, CI, etc.).
const CATALOG_URL = "https://ara.engineer/mcp.json";
const CATALOG_URL_LOCAL = "http://localhost:3210/mcp.json";

type Server = {
  id: string;
  name: string;
  source: "ara" | "official";
  url?: string;
  auth?: string;
  env?: string[];
  client_native?: string[];
  summary: string;
};

type Catalog = {
  version: number;
  updated: string;
  ara_endpoint: { url: string; fallback_url?: string; auth: string; description: string };
  servers: Server[];
  planned: Array<{ id: string; name: string; reason: string }>;
};

async function fetchCatalog(): Promise<Catalog> {
  // Prefer local during dev
  for (const url of [process.env.AE_MCP_CATALOG_URL, CATALOG_URL_LOCAL, CATALOG_URL].filter(Boolean) as string[]) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json() as Catalog;
    } catch { /* try next */ }
  }
  throw new Error(`Could not fetch MCP catalog from ${CATALOG_URL}. Check your network.`);
}

function printHelp() {
  console.log(`aracli mcp — manage MCP connectors for the Ara team

Usage:
  aracli mcp list [--json]              show the full catalog
  aracli mcp url <id>                   print a server's URL
  aracli mcp setup-codex [--write]      emit or write ~/.codex/config.toml
  aracli mcp setup-claude [--write]     emit or write ~/.claude.json (Claude Code / Desktop)
  aracli mcp setup-chatgpt              open ChatGPT's connector page + print step-by-step

Flags:
  --write    actually write the config file (default: print to stdout)
  --json     machine-readable

Catalog source: ${CATALOG_URL}
`);
}

async function listSubcommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  try {
    const cat = await fetchCatalog();
    if (json) {
      console.log(JSON.stringify(cat, null, 2));
      return 0;
    }
    console.log(`MCP catalog (v${cat.version}, updated ${cat.updated})\n`);
    const groups: Record<string, Server[]> = { ara: [], official: [] };
    for (const s of cat.servers) groups[s.source].push(s);
    for (const [label, servers] of [["Ara-managed", groups.ara], ["Official", groups.official]] as const) {
      console.log(`── ${label} ──`);
      for (const s of servers) {
        const url = s.url ?? (s.client_native ? `[native in ${s.client_native.join(", ")}]` : "-");
        console.log(`  ${s.id.padEnd(20)} ${url}`);
        console.log(`  ${" ".repeat(20)} ${s.summary}\n`);
      }
    }
    if (cat.planned.length) {
      console.log("── Planned ──");
      for (const p of cat.planned) console.log(`  ${p.id.padEnd(20)} ${p.reason}`);
    }
    return 0;
  } catch (e: any) {
    console.error(e.message);
    return 1;
  }
}

async function urlSubcommand(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) { console.error("aracli mcp url: missing <id>"); return 2; }
  try {
    const cat = await fetchCatalog();
    const s = cat.servers.find((x) => x.id === id);
    if (!s) { console.error(`aracli mcp url: no server with id '${id}'`); return 1; }
    if (!s.url) { console.error(`aracli mcp url: '${id}' has no URL (client-native)`); return 1; }
    console.log(s.url);
    return 0;
  } catch (e: any) {
    console.error(e.message);
    return 1;
  }
}

function toCodexToml(cat: Catalog): string {
  let out = "# Written by `aracli mcp setup-codex` — https://ara.engineer/mcp\n";
  out += `# Catalog version ${cat.version}, updated ${cat.updated}\n\n`;
  for (const s of cat.servers) {
    if (!s.url) continue;
    const id = s.id.replace(/-/g, "_");
    out += `[mcp_servers.${id}]\n`;
    out += `url = "${s.url}"\n`;
    if (s.auth === "oauth") out += `# OAuth — Codex will open a browser on first use\n`;
    if (s.auth === "api-key-in-url") out += `# Replace the env placeholder in the URL before use\n`;
    if (s.env?.length) out += `# Requires env: ${s.env.join(", ")}\n`;
    out += `\n`;
  }
  return out;
}

function toClaudeJson(cat: Catalog): any {
  const mcpServers: Record<string, any> = {};
  for (const s of cat.servers) {
    if (!s.url) continue;
    const id = s.id.replace(/-/g, "_");
    mcpServers[id] = { type: "http", url: s.url };
  }
  return { mcpServers };
}

async function setupCodex(args: string[]): Promise<number> {
  const write = args.includes("--write");
  const cat = await fetchCatalog();
  const toml = toCodexToml(cat);
  if (!write) {
    console.log(toml);
    console.log(`\n# To apply: aracli mcp setup-codex --write`);
    return 0;
  }
  const path = join(homedir(), ".codex", "config.toml");
  if (existsSync(path)) {
    const backup = `${path}.bak.${Date.now()}`;
    writeFileSync(backup, readFileSync(path));
    console.log(`Backed up existing config → ${backup}`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  // Merge: preserve anything not in [mcp_servers.*] sections that ae manages
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const stripped = existing
    .split(/\n(?=\[)/)
    .filter((block) => !block.trim().startsWith("[mcp_servers."))
    .join("\n")
    .trim();
  const merged = (stripped ? stripped + "\n\n" : "") + toml;
  writeFileSync(path, merged);
  console.log(`Wrote ${path} (${cat.servers.filter((s) => s.url).length} servers)`);
  return 0;
}

async function setupClaude(args: string[]): Promise<number> {
  const write = args.includes("--write");
  const cat = await fetchCatalog();
  const config = toClaudeJson(cat);
  if (!write) {
    console.log(JSON.stringify(config, null, 2));
    console.log(`\n// To apply: aracli mcp setup-claude --write`);
    console.log(`// Merges into ~/.claude.json (Claude Code). For Claude Desktop, copy into ~/Library/Application Support/Claude/claude_desktop_config.json`);
    return 0;
  }
  const path = join(homedir(), ".claude.json");
  let existing: any = {};
  if (existsSync(path)) {
    const backup = `${path}.bak.${Date.now()}`;
    writeFileSync(backup, readFileSync(path));
    try { existing = JSON.parse(readFileSync(path, "utf8")); } catch { existing = {}; }
    console.log(`Backed up existing config → ${backup}`);
  }
  existing.mcpServers = { ...(existing.mcpServers ?? {}), ...config.mcpServers };
  writeFileSync(path, JSON.stringify(existing, null, 2));
  console.log(`Wrote ${path} (${Object.keys(config.mcpServers).length} servers merged)`);
  return 0;
}

async function setupChatgpt(_args: string[]): Promise<number> {
  const cat = await fetchCatalog();
  console.log(`ChatGPT MCP setup — requires Pro/Business/Enterprise + Developer Mode enabled.\n`);
  console.log(`1. Open: https://chatgpt.com/#settings/Connectors`);
  console.log(`2. Click "Create" (or "Add custom connector") for each URL below.`);
  console.log(`3. Trust the connector when prompted.\n`);
  console.log(`URLs:\n`);
  for (const s of cat.servers) {
    if (!s.url) continue;
    console.log(`  ${s.name.padEnd(20)} ${s.url}`);
  }
  console.log(`\nNative ChatGPT connectors (use the built-in gallery instead):`);
  for (const s of cat.servers) {
    if (s.client_native?.includes("chatgpt")) console.log(`  ${s.name}`);
  }
  return 0;
}

export async function mcpCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === "-h" || sub === "--help") { printHelp(); return 0; }
  switch (sub) {
    case "list": return await listSubcommand(rest);
    case "url": return await urlSubcommand(rest);
    case "setup-codex": return await setupCodex(rest);
    case "setup-claude": return await setupClaude(rest);
    case "setup-chatgpt": return await setupChatgpt(rest);
    default:
      console.error(`aracli mcp: unknown subcommand '${sub}'`);
      printHelp();
      return 2;
  }
}
