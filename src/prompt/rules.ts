import fs from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "../config";
import { parseFrontmatter } from "./frontmatter";

const MAX_FILE = 20_000;

export interface RuleFile {
  /** 相对工作区的路径 */
  file: string;
  title: string;
  /** always：每次都带上；optional：只列出名字和说明，模型按需读取 */
  kind: "always" | "optional";
  description?: string;
  chars: number;
  content: string;
}

function read(file: string): string | undefined {
  try {
    const t = fs.readFileSync(file, "utf8");
    return t.length > MAX_FILE ? t.slice(0, MAX_FILE) + "\n…（过长，已截断）" : t;
  } catch {
    return undefined;
  }
}

function walk(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  let out: string[] = [];
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out = out.concat(walk(p, depth + 1));
    else if (/\.(mdc|md)$/i.test(d.name)) out.push(p);
  }
  return out.sort();
}

/** 读取工作区里的项目规则：AGENTS.md 和 .cursor/rules/*.mdc|md（兼容 Cursor 的格式） */
export function loadProjectRules(root: string): RuleFile[] {
  const out: RuleFile[] = [];
  const agents = read(path.join(root, "AGENTS.md"));
  if (agents?.trim()) out.push({ file: "AGENTS.md", title: "AGENTS.md", kind: "always", chars: agents.length, content: agents });

  for (const f of walk(path.join(root, ".cursor", "rules"))) {
    const raw = read(f);
    if (!raw?.trim()) continue;
    const { meta, body, hasMeta } = parseFrontmatter(raw);
    const rel = path.relative(root, f).replace(/\\/g, "/");
    const globs = Array.isArray(meta.globs) ? meta.globs.join(", ") : typeof meta.globs === "string" ? meta.globs : "";
    const description = [meta.description, globs && `适用：${globs}`].filter(Boolean).join("；") || undefined;
    // 没有任何头信息的规则视为始终生效；有头信息时看 alwaysApply
    const always = !hasMeta || meta.alwaysApply === true;
    out.push({ file: rel, title: path.basename(f).replace(/\.(mdc|md)$/i, ""), kind: always ? "always" : "optional", description, chars: body.length, content: body.trim() });
  }
  return out;
}

/** 拼出追加到 system prompt 里的「规则」部分；没有任何规则时返回空串 */
export function buildRulesSection(cfg: HarnessConfig["rules"], root: string): string {
  const parts: string[] = [];
  const items = cfg.items.filter(r => r.enabled && r.content.trim());
  if (items.length) {
    parts.push("## 规则（必须遵守）\n" + items.map(r => (r.title ? `### ${r.title}\n` : "") + r.content.trim()).join("\n\n"));
  }
  if (cfg.useProjectFiles) {
    const files = loadProjectRules(root);
    const always = files.filter(f => f.kind === "always");
    if (always.length) parts.push("## 项目规则（必须遵守）\n" + always.map(f => `### ${f.file}\n${f.content.trim()}`).join("\n\n"));
    const optional = files.filter(f => f.kind === "optional");
    if (optional.length) {
      parts.push("## 可选项目规则（与当前任务相关时，用 read_file 读取后遵守）\n" + optional.map(f => `- ${f.file}${f.description ? `：${f.description}` : ""}`).join("\n"));
    }
  }
  return parts.join("\n\n");
}
