import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { buildRulesSection, loadProjectRules } from "../src/prompt/rules";
import { readSkillBody, scanSkills, skillsPrompt, skillTool } from "../src/prompt/skills";

let dir: string;
const w = (rel: string, text: string) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("规则", () => {
  it("读取 AGENTS.md 与 .cursor/rules，区分始终生效和按需读取", () => {
    w("AGENTS.md", "用中文回复");
    w(".cursor/rules/style.mdc", "---\nalwaysApply: true\n---\n缩进用 2 个空格");
    w(".cursor/rules/api.mdc", "---\ndescription: 接口约定\nglobs: src/api/**\nalwaysApply: false\n---\n接口都要加版本号");
    w(".cursor/rules/plain.md", "没有头信息也生效");
    const files = loadProjectRules(dir);
    expect(files.map(f => [f.file, f.kind])).toEqual([
      ["AGENTS.md", "always"],
      [".cursor/rules/api.mdc", "optional"],
      [".cursor/rules/plain.md", "always"],
      [".cursor/rules/style.mdc", "always"],
    ]);
    const cfg = parseConfig({ rules: { items: [{ id: "1", title: "安全", content: "不要泄露密钥" }, { id: "2", content: "停用的", enabled: false }] } }).rules;
    const text = buildRulesSection(cfg, dir);
    expect(text).toContain("不要泄露密钥");
    expect(text).not.toContain("停用的");
    expect(text).toContain("用中文回复");
    expect(text).toContain("缩进用 2 个空格");
    expect(text).not.toContain("接口都要加版本号"); // 可选规则只列名字
    expect(text).toContain(".cursor/rules/api.mdc：接口约定；适用：src/api/**");
  });

  it("关闭 useProjectFiles 后不读项目文件；没有规则时返回空串", () => {
    w("AGENTS.md", "x");
    expect(buildRulesSection(parseConfig({ rules: { useProjectFiles: false } }).rules, dir)).toBe("");
  });
});

describe("技能", () => {
  it("扫描技能目录、同名按优先级去重，use_skill 返回正文", async () => {
    w(".cursor/skills/review/SKILL.md", "---\nname: review\ndescription: 代码审查\n---\n# 审查\n先看改动范围");
    w(".cursor/skills/review/checklist.md", "x");
    w("home/skills/review/SKILL.md", "---\nname: review\ndescription: 被项目里的同名技能覆盖\n---\nold");
    w("home/skills/weekly/SKILL.md", "---\ndescription: 写周报\n---\n列出本周完成的事");
    w("home/skills/not-a-skill/readme.md", "没有 SKILL.md");
    const skills = scanSkills({ root: dir, home: path.join(dir, "home"), userDirs: false });
    const mine = skills;
    expect(mine.map(s => [s.name, s.source, s.description])).toEqual([
      ["review", "project", "代码审查"],
      ["weekly", "app", "写周报"],
    ]);
    expect(skillsPrompt(mine)).toContain("- review：代码审查");
    expect(skillsPrompt([])).toBe("");
    expect(readSkillBody(mine[0])).toBe("# 审查\n先看改动范围");

    const tool = skillTool(mine);
    const out = await tool.run({ name: "review" }, { signal: new AbortController().signal, root: dir });
    expect(out).toContain("先看改动范围");
    expect(out).toContain("checklist.md");
    expect(await tool.run({ name: "nope" }, { signal: new AbortController().signal, root: dir })).toContain("没有名为 nope");
  });
});
