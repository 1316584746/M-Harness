import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { slug } from "../shared/plugins";
import { scanDir, splitFrontmatter, type Ctx } from "./repo-import";

/**
 * 从本机读技能 / MCP / 动作 / 规则：
 *   · 「加载」：用户选一个文件夹，软件在里面找这一类内容（技能、mcp.json、commands、规则……）
 *   · 「同步」：Cursor / Claude Code / Codex 自己在本机放的那一份（它们的用户目录），列出来让用户挑着同步
 * 解析复用 GitHub 导入那一套（scanDir）：把本机文件摆成一个「虚拟仓库」，同样的规则找内容，同样的格式出条目。
 */

const MAX_FILE = 200_000;
const MAX_FILES = 4000;
const MAX_DEPTH = 7;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|__pycache__)(\/|$)/;

export interface LocalMap {
  /** 在虚拟仓库里的路径（文件夹或文件） */
  virtual: string;
  /** 本机的真实路径（文件夹或文件，不存在就忽略） */
  real: string;
}

export interface LocalScan {
  /** 本软件插件源格式的条目（交给 parseMarketplace 校验） */
  raw: any[];
  /** 技能条目 id → 技能所在的本机文件夹（添加时把里面的附带文件一起拷过来；SKILL.md 在根目录的不带） */
  skillDirs: Map<string, string>;
  notes: string[];
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const firstLine = (s: string) => (s.split("\n").map(x => x.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "").slice(0, 200);
const strRec = (v: unknown): Record<string, string> | undefined => {
  if (!isObj(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return Object.keys(out).length ? out : undefined;
};

function walkInto(dir: string, vdir: string, files: Map<string, string>, seen: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH || files.size >= MAX_FILES) return;
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (seen.has(real)) return; // 链接绕回来了
  seen.add(real);
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const v = vdir ? `${vdir}/${e.name}` : e.name;
    if (SKIP.test(v)) continue;
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const s = fs.statSync(p);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) walkInto(p, v, files, seen, depth + 1);
    else if (isFile && files.size < MAX_FILES) files.set(v, p);
  }
}

/** 把本机的文件夹 / 文件摆成一个「虚拟仓库」：路径是虚拟的，读文件时换回真实路径 */
export function localCtx(maps: LocalMap[], name: string): { ctx: Ctx; files: Map<string, string> } {
  const files = new Map<string, string>();
  const seen = new Set<string>();
  for (const m of maps) {
    let st: fs.Stats;
    try {
      st = fs.statSync(m.real);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkInto(m.real, m.virtual, files, seen, 0);
    else if (st.isFile()) files.set(m.virtual, m.real);
  }
  const ctx: Ctx = {
    src: { owner: "本机", repo: name, dir: "" },
    tree: [...files.keys()],
    raw: () => "",
    fetchText: async p => {
      const f = files.get(p);
      if (!f) throw new Error("文件不存在");
      if (fs.statSync(f).size > MAX_FILE) throw new Error("文件太大，已跳过");
      return fs.readFileSync(f, "utf8");
    },
    fetchBytes: async () => {
      throw new Error("本机导入不走下载");
    },
  };
  return { ctx, files };
}

// ───────────── Codex 的 config.toml（只读 [mcp_servers.*]） ─────────────

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function balanced(s: string): boolean {
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth <= 0;
}

/** 按顶层的逗号拆开（引号、括号里的不算） */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') cur += s[++i] ?? "";
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function unquoteKey(k: string): string {
  if (k.startsWith('"')) {
    try {
      return JSON.parse(k);
    } catch {
      return k.slice(1, -1);
    }
  }
  return k.startsWith("'") ? k.slice(1, -1) : k;
}

function parseValue(s: string): unknown {
  const t = s.trim();
  if (!t) return undefined;
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.replace(/^"|"$/g, "");
    }
  }
  if (t.startsWith("'")) return t.replace(/^'|'$/g, "");
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(t)) return Number(t.replace(/_/g, ""));
  if (t.startsWith("[") && t.endsWith("]")) return splitTop(t.slice(1, -1)).map(parseValue).filter(v => v !== undefined);
  if (t.startsWith("{") && t.endsWith("}")) {
    const o: Record<string, unknown> = {};
    for (const part of splitTop(t.slice(1, -1))) {
      const kv = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*([\s\S]*)$/.exec(part);
      if (kv) o[unquoteKey(kv[1])] = parseValue(kv[2]);
    }
    return o;
  }
  return undefined;
}

/** 读 Codex config.toml 里的 [mcp_servers.名字]（含 .env 子表）。只认这一块，别的内容忽略 */
export function parseCodexMcp(text: string): Record<string, Record<string, any>> {
  const servers: Record<string, Record<string, any>> = {};
  let cur: { name: string; sub?: string } | null = null;
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    if (line.startsWith("[[")) {
      cur = null;
      continue;
    }
    const h = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (h) {
      const parts = [...h[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
      cur = parts[0] === "mcp_servers" && parts.length >= 2 ? { name: parts[1], sub: parts[2] } : null;
      if (cur) servers[cur.name] ??= {};
      continue;
    }
    if (!cur) continue;
    const kv = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let rest = kv[2];
    while (!balanced(rest) && i + 1 < lines.length) rest += " " + stripComment(lines[++i]).trim(); // 数组 / 内联表可以跨行
    const val = parseValue(rest);
    if (val === undefined) continue;
    const target = cur.sub ? (servers[cur.name][cur.sub] ??= {}) : servers[cur.name];
    target[unquoteKey(kv[1])] = val;
  }
  return servers;
}

/** 各家 CLI 的 MCP 配置 → 本软件的 MCP 服务格式（只留认识的字段） */
export function toServer(s: unknown): Record<string, unknown> | null {
  if (!isObj(s)) return null;
  const out: Record<string, unknown> = {};
  if (typeof s.command === "string" && s.command.trim()) out.command = s.command.trim();
  if (Array.isArray(s.args)) out.args = s.args.filter((a: unknown) => typeof a === "string");
  const env = strRec(s.env);
  if (env) out.env = env;
  if (typeof s.url === "string" && /^https?:\/\//.test(s.url)) out.url = s.url;
  const headers = strRec(s.http_headers ?? s.headers);
  if (headers) out.headers = headers;
  return out.command || out.url ? out : null;
}

// ───────────── 找内容 ─────────────

function mcpRaw(prefix: string, label: string, servers: Record<string, unknown>, ids: Set<string>): any[] {
  const out: any[] = [];
  for (const [name, s] of Object.entries(servers)) {
    const server = toServer(s);
    if (!server) continue;
    const id = `${prefix}/mcp-${slug(name)}`;
    if (ids.has(id)) continue;
    ids.add(id);
    out.push({ id, name, kind: "mcp", description: `${label} 里的 MCP 服务「${name}」`, author: "本机", tags: ["本机"], install: { server, note: (server.env as object | undefined) && Object.keys(server.env as object).length ? "装好后到「设置 → MCP」检查环境变量" : undefined } });
  }
  return out;
}

async function ruleFiles(c: Ctx, prefix: string, ids: Set<string>): Promise<any[]> {
  const out: any[] = [];
  for (const f of ["AGENTS.md", "CLAUDE.md"]) {
    if (!c.tree.includes(f)) continue;
    try {
      const { body } = splitFrontmatter(await c.fetchText(f));
      if (!body) continue;
      const id = `${prefix}/rule-file-${slug(f)}`;
      if (ids.has(id)) continue;
      ids.add(id);
      out.push({ id, name: f, kind: "rule", description: firstLine(body) || `${f} 里的规则`, author: "本机", tags: ["本机"], install: { content: body } });
    } catch {
      /* 读不了就算了 */
    }
  }
  return out;
}

/** scanDir 是给 GitHub 仓库写的：本机来源没有仓库地址 / 下载地址，把这些去掉，并记下每个技能的本机文件夹 */
function finish(raw: any[], files: Map<string, string>, label: string): LocalScan["skillDirs"] {
  const skillDirs = new Map<string, string>();
  for (const r of raw) {
    delete r.repo;
    delete r.homepage;
    if (Array.isArray(r.tags)) r.tags = r.tags.filter((t: string) => t !== "github");
    if (typeof r.description === "string") r.description = r.description.replace(`本机/${label} 里的`, `「${label}」里的`);
    if (r.kind === "skill") {
      if (isObj(r.install)) delete r.install.files;
      if (typeof r._dir === "string" && r._dir) {
        const f = files.get(`${r._dir}/SKILL.md`);
        if (f) skillDirs.set(r.id, path.dirname(f));
      }
    }
  }
  return skillDirs;
}

async function scanMaps(maps: LocalMap[], label: string, prefix: string, extra: (c: Ctx, ids: Set<string>) => Promise<any[]>): Promise<LocalScan> {
  const { ctx, files } = localCtx(maps, label);
  const { raw, notes } = await scanDir(ctx, "", prefix, { author: "本机", tags: ["本机"] });
  const ids = new Set<string>(raw.map(r => r.id));
  raw.push(...(await ruleFiles(ctx, prefix, ids)), ...(await extra(ctx, ids)));
  return { raw, skillDirs: finish(raw, files, label), notes };
}

/** 「加载」：用户选的文件夹。认得 .cursor / .claude / .codex 这些工具的用户目录，也认 commands、rules、prompts 文件夹本身 */
export async function scanLocalFolder(dir: string): Promise<LocalScan> {
  const root = path.resolve(dir);
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch {
    throw new Error("这个文件夹不存在");
  }
  if (!st.isDirectory()) throw new Error("请选择一个文件夹");
  const base = path.basename(root).toLowerCase();
  const label = path.basename(root) || root;
  const prefix = `local-${slug(label)}`;
  const at = (...p: string[]) => path.join(root, ...p);

  if (base === ".codex") {
    return scanMaps(
      [
        { virtual: "skills", real: at("skills") },
        { virtual: "commands", real: at("prompts") },
        { virtual: "AGENTS.md", real: at("AGENTS.md") },
      ],
      label,
      prefix,
      async (_c, ids) => mcpRaw(prefix, `「${label}」`, tomlServers(at("config.toml")), ids),
    );
  }
  const virtual = ({ ".cursor": ".cursor", ".claude": ".claude", commands: "commands", prompts: "commands", rules: ".cursor/rules" } as Record<string, string>)[base] ?? "";
  return scanMaps([{ virtual, real: root }], label, prefix, async (_c, ids) => {
    const out = mcpRaw(prefix, `「${label}」`, tomlServers(at("config.toml")), ids);
    // 用户自己的 claude.json 风格文件：根目录里有 .claude.json 时读它的 mcpServers
    out.push(...mcpRaw(prefix, `「${label}」`, jsonServers(at(".claude.json")), ids));
    return out;
  });
}

function tomlServers(file: string): Record<string, unknown> {
  try {
    return parseCodexMcp(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function jsonServers(file: string): Record<string, unknown> {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return isObj(j) && isObj(j.mcpServers) ? j.mcpServers : {};
  } catch {
    return {};
  }
}

// ───────────── 同步：Cursor / Claude Code / Codex 在本机的那一份 ─────────────

export type PlatformId = "cursor" | "claude" | "codex";
export const PLATFORM_NAME: Record<PlatformId, string> = { cursor: "Cursor", claude: "Claude Code", codex: "Codex" };
export const PLATFORM_IDS = Object.keys(PLATFORM_NAME) as PlatformId[];

/** 这个平台的用户目录（Claude Code、Codex 认环境变量） */
export function platformDir(id: PlatformId, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (id === "claude") return env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  if (id === "codex") return env.CODEX_HOME?.trim() || path.join(home, ".codex");
  return path.join(home, ".cursor");
}

export function platformFound(id: PlatformId, home?: string, env?: NodeJS.ProcessEnv): boolean {
  return fs.existsSync(platformDir(id, home, env));
}

export async function scanPlatform(id: PlatformId, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): Promise<LocalScan> {
  const dir = platformDir(id, home, env);
  const name = PLATFORM_NAME[id];
  const prefix = `platform-${id}`;
  const at = (...p: string[]) => path.join(dir, ...p);
  let r: LocalScan;
  if (id === "cursor") {
    r = await scanMaps(
      [
        { virtual: "skills", real: at("skills") },
        { virtual: "commands", real: at("commands") },
        { virtual: "mcp.json", real: at("mcp.json") },
      ],
      name,
      prefix,
      async () => [],
    );
    r.notes.push("Cursor 的「用户规则」存在它自己的设置里，读不到，需要的话请手动复制");
  } else if (id === "claude") {
    const json = path.join(env.CLAUDE_CONFIG_DIR?.trim() ? dir : home, ".claude.json");
    r = await scanMaps(
      [
        { virtual: "skills", real: at("skills") },
        { virtual: "commands", real: at("commands") },
        { virtual: "CLAUDE.md", real: at("CLAUDE.md") },
      ],
      name,
      prefix,
      async (_c, ids) => mcpRaw(prefix, name, jsonServers(json), ids),
    );
  } else {
    r = await scanMaps(
      [
        { virtual: "skills", real: at("skills") },
        { virtual: "commands", real: at("prompts") },
        { virtual: "AGENTS.md", real: at("AGENTS.md") },
      ],
      name,
      prefix,
      async (_c, ids) => mcpRaw(prefix, name, tomlServers(at("config.toml")), ids),
    );
  }
  for (const x of r.raw) {
    x.tags = [name, ...(Array.isArray(x.tags) ? x.tags.filter((t: string) => t !== "本机") : [])];
    x.author = name;
    if (typeof x.description === "string") x.description = x.description.replace(`「${name}」里的`, `${name} 里的`);
  }
  return r;
}

// ───────────── 拷技能文件夹里的附带文件 ─────────────

/** 把本机技能文件夹里的附带文件（脚本、参考资料）拷到技能目录；返回没拷的。最多 40 个，每个最大 1MB，总共最多 8MB */
export function copySkillFiles(srcDir: string, destDir: string): string[] {
  const skipped: string[] = [];
  const destRoot = path.resolve(destDir);
  const seen = new Set<string>();
  let total = 0;
  let count = 0;
  const visit = (dir: string, rel: string, depth: number) => {
    if (depth > 4) return;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.test(r) || /^SKILL\.md$/i.test(e.name) || e.name === ".DS_Store") continue;
      const p = path.join(dir, e.name);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(p, r, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (count >= 40) {
        skipped.push(r);
        continue;
      }
      if (st.size > 1_000_000 || total + st.size > 8_000_000) {
        skipped.push(`${r}（太大）`);
        continue;
      }
      const target = path.resolve(destRoot, r);
      if (!target.startsWith(destRoot + path.sep)) continue;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(p, target);
        count++;
        total += st.size;
      } catch {
        skipped.push(r);
      }
    }
  };
  visit(srcDir, "", 0);
  return skipped;
}
