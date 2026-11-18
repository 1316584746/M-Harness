import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types";
import { parseFrontmatter } from "./frontmatter";

export type SkillSource = "project" | "app" | "custom" | "user";

export interface Skill {
  name: string;
  description: string;
  /** 技能文件夹 */
  dir: string;
  file: string;
  source: SkillSource;
}

export interface ScanOptions {
  /** 工作区根目录：扫描 .cursor/skills 与 .agents/skills */
  root: string;
  /** 应用数据目录：扫描 <home>/skills（设置里新建的技能放在这里） */
  home?: string;
  /** 配置里额外指定的目录 */
  dirs?: string[];
  /** 是否扫描用户目录（默认 true） */
  userDirs?: boolean;
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

function scanDir(dir: string, source: SkillSource): Skill[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const d of names) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    const file = path.join(dir, d.name, "SKILL.md");
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(text);
    const description = String(meta.description ?? body.split("\n").find(l => l.trim() && !l.startsWith("#")) ?? "").trim().slice(0, 300);
    out.push({ name: String(meta.name || d.name), description, dir: path.join(dir, d.name), file, source });
  }
  return out;
}

/** 扫描所有技能目录；同名技能按优先级只保留一个：项目 > 应用 > 自定义目录 > 用户目录 */
export function scanSkills(o: ScanOptions): Skill[] {
  const roots: Array<[string, SkillSource]> = [
    [path.join(o.root, ".cursor", "skills"), "project"],
    [path.join(o.root, ".agents", "skills"), "project"],
    ...(o.home ? ([[path.join(o.home, "skills"), "app"]] as Array<[string, SkillSource]>) : []),
    ...(o.dirs ?? []).map(d => [path.resolve(o.root, d), "custom"] as [string, SkillSource]),
    ...(o.userDirs === false
      ? []
      : ([
          [path.join(os.homedir(), ".cursor", "skills"), "user"],
          [path.join(os.homedir(), ".agents", "skills"), "user"],
        ] as Array<[string, SkillSource]>)),
  ];
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const [dir, source] of roots) {
    for (const s of scanDir(dir, source)) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push(s);
    }
  }
  return out;
}

export function readSkillBody(s: Skill): string {
  return parseFrontmatter(fs.readFileSync(s.file, "utf8")).body.trim();
}

/** 写进 system prompt 的技能目录：只放名字和说明，正文由模型按需用 use_skill 读取 */
export function skillsPrompt(skills: Skill[]): string {
  if (!skills.length) return "";
  return (
    "## 可用技能\n任务与下列某个技能匹配时，先调用 use_skill 读取它的完整说明，再按说明执行。\n" +
    skills.map(s => `- ${s.name}：${s.description || "（无说明）"}`).join("\n")
  );
}

export function skillTool(skills: Skill[]): Tool {
  return {
    name: "use_skill",
    description: "读取一个技能的完整说明（SKILL.md）。可用技能见系统提示里的「可用技能」。",
    risk: "read",
    schema: z.object({ name: z.string().describe("技能名") }),
    async run({ name }) {
      const s = skills.find(x => x.name === name);
      if (!s) return `错误：没有名为 ${name} 的技能，可用：${skills.map(x => x.name).join(", ")}`;
      let files: string[] = [];
      try {
        files = fs.readdirSync(s.dir).filter(f => f !== "SKILL.md").slice(0, 30);
      } catch {
        /* ignore */
      }
      return `${readSkillBody(s)}\n\n---\n技能目录：${s.dir}${files.length ? `\n目录内的其他文件：${files.join(", ")}` : ""}`;
    },
  };
}
