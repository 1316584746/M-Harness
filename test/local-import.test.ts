import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copySkillFiles, parseCodexMcp, platformFound, scanLocalFolder, scanPlatform } from "../desktop/main/local-import";
import { parseMarketplace } from "../desktop/shared/plugins";

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-import-"))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const put = (rel: string, text: string) => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const items = (raw: any[]) => parseMarketplace({ plugins: raw }, "t").entries;

describe("parseCodexMcp", () => {
  it("读 [mcp_servers.x]、env 子表、跨行数组和内联表", () => {
    const m = parseCodexMcp(`
model = "gpt-5"
[mcp_servers.fs]
command = "npx"
args = ["-y", "@x/server", "--root", "C:\\\\a"]  # 注释
[mcp_servers.fs.env]
TOKEN = "abc#1"
[mcp_servers.web]
url = "https://example.com/mcp"
http_headers = { Authorization = "Bearer x" }
[mcp_servers.multi]
command = "node"
args = [
  "a.js",
  "b.js",
]
[other]
x = 1
`);
    expect(m.fs).toEqual({ command: "npx", args: ["-y", "@x/server", "--root", "C:\\a"], env: { TOKEN: "abc#1" } });
    expect(m.web).toEqual({ url: "https://example.com/mcp", http_headers: { Authorization: "Bearer x" } });
    expect(m.multi.args).toEqual(["a.js", "b.js"]);
    expect(m.other).toBeUndefined();
  });
});

describe("scanPlatform", () => {
  it("Claude Code：技能、命令、CLAUDE.md、.claude.json 的 MCP", async () => {
    put(".claude/skills/review/SKILL.md", "---\nname: review\ndescription: 审代码\n---\n步骤");
    put(".claude/skills/review/refs/a.md", "ref");
    put(".claude/commands/ship.md", "---\ndescription: 提交\n---\n提交代码 {{input}}");
    put(".claude/CLAUDE.md", "总是用中文回复");
    put(".claude.json", JSON.stringify({ mcpServers: { git: { command: "uvx", args: ["mcp-git"] }, bad: { foo: 1 } } }));
    expect(platformFound("claude", tmp, {})).toBe(true);
    const r = await scanPlatform("claude", tmp, {});
    const list = items(r.raw);
    const kinds = list.map(i => `${i.kind}:${i.name}`).sort();
    expect(kinds).toContain("skill:review");
    expect(kinds).toContain("mcp:git");
    expect(kinds.some(k => k.startsWith("action:"))).toBe(true);
    expect(kinds.some(k => k.startsWith("rule:"))).toBe(true);
    expect(kinds.some(k => k.includes("bad"))).toBe(false);
    const sk = list.find(i => i.kind === "skill")!;
    expect(r.skillDirs.get(sk.id)).toBe(path.join(tmp, ".claude", "skills", "review"));
    expect(list.every(i => i.author === "Claude Code")).toBe(true);
  });

  it("Codex：config.toml 的 MCP、prompts 当动作；目录不存在时是空的", async () => {
    put(".codex/config.toml", `[mcp_servers.a]\ncommand = "a"\n`);
    put(".codex/prompts/fix.md", "修 bug");
    const list = items((await scanPlatform("codex", tmp, {})).raw);
    expect(list.map(i => `${i.kind}:${i.name}`)).toEqual(expect.arrayContaining(["mcp:a"]));
    expect(list.some(i => i.kind === "action")).toBe(true);
    expect(platformFound("cursor", tmp, {})).toBe(false);
    expect((await scanPlatform("cursor", tmp, {})).raw).toEqual([]);
  });

  it("Cursor：mcp.json 和 skills", async () => {
    put(".cursor/mcp.json", JSON.stringify({ mcpServers: { s: { url: "https://x.test/mcp" } } }));
    put(".cursor/skills/foo/SKILL.md", "---\nname: foo\ndescription: d\n---\nbody");
    const r = await scanPlatform("cursor", tmp, {});
    const names = items(r.raw).map(i => `${i.kind}:${i.name}`);
    expect(names).toEqual(expect.arrayContaining(["mcp:s", "skill:foo"]));
    expect(r.notes.join("")).toContain("用户规则");
  });
});

describe("scanLocalFolder", () => {
  it("在文件夹里找各类内容", async () => {
    put("proj/skills/a/SKILL.md", "---\nname: a\ndescription: d\n---\nbody");
    put("proj/.cursor/rules/style.mdc", "---\ndescription: 风格\nalwaysApply: true\n---\n用两空格缩进");
    put("proj/AGENTS.md", "项目约定");
    const r = await scanLocalFolder(path.join(tmp, "proj"));
    const names = items(r.raw).map(i => `${i.kind}:${i.name}`);
    expect(names).toContain("skill:a");
    expect(names.filter(n => n.startsWith("rule:")).length).toBeGreaterThanOrEqual(2);
  });

  it("文件夹不存在 / 是文件时报错", async () => {
    await expect(scanLocalFolder(path.join(tmp, "nope"))).rejects.toThrow("不存在");
    put("f.txt", "x");
    await expect(scanLocalFolder(path.join(tmp, "f.txt"))).rejects.toThrow("文件夹");
  });
});

describe("copySkillFiles", () => {
  it("拷附带文件（不含 SKILL.md、node_modules），越界路径不会出现", () => {
    put("s/SKILL.md", "x");
    put("s/run.sh", "echo");
    put("s/refs/deep/a.md", "a");
    put("s/node_modules/x.js", "no");
    const dest = path.join(tmp, "out", "s");
    const skipped = copySkillFiles(path.join(tmp, "s"), dest);
    expect(skipped).toEqual([]);
    expect(fs.existsSync(path.join(dest, "run.sh"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "refs/deep/a.md"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "node_modules"))).toBe(false);
  });

  it("太大的文件会被跳过并报告", () => {
    put("s/big.bin", "x".repeat(1_000_001));
    const skipped = copySkillFiles(path.join(tmp, "s"), path.join(tmp, "o"));
    expect(skipped).toEqual(["big.bin（太大）"]);
  });
});
