import { describe, expect, it } from "vitest";
import { importGithubRepo, parseGithubUrl, splitFrontmatter } from "../desktop/main/repo-import";

/** 假 GitHub：repos[owner/repo] = { 路径: 内容 } */
function fakeGithub(repos: Record<string, Record<string, string>>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    const tree = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\//.exec(url);
    if (tree) {
      const files = repos[tree[1]];
      if (!files) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ tree: Object.keys(files).map(path => ({ path, type: "blob" })) }), { status: 200 });
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/[^/]+\/(.+)$/.exec(url);
    if (raw) {
      const body = repos[raw[1]]?.[decodeURIComponent(raw[2]).replace(/%2F/g, "/")];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body, { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

const noDbx = () => {
  throw new Error("不该走 DBX");
};

describe("parseGithubUrl", () => {
  it("认仓库链接、owner/repo 简写和子目录", () => {
    expect(parseGithubUrl("https://github.com/a/b")).toEqual({ owner: "a", repo: "b", dir: "" });
    expect(parseGithubUrl("a/b")).toEqual({ owner: "a", repo: "b", dir: "" });
    expect(parseGithubUrl("https://github.com/a/b.git")).toEqual({ owner: "a", repo: "b", dir: "" });
    expect(parseGithubUrl("https://github.com/a/b/tree/dev/plugins/x")).toEqual({ owner: "a", repo: "b", ref: "dev", dir: "plugins/x" });
  });
  it("不是仓库首页 / 不是 GitHub 的返回 null", () => {
    expect(parseGithubUrl("https://github.com/a/b/issues/3")).toBeNull();
    expect(parseGithubUrl("https://example.com/a/b")).toBeNull();
    expect(parseGithubUrl("https://example.com/catalog/index.json")).toBeNull();
    expect(parseGithubUrl("不是地址")).toBeNull();
  });
});

describe("splitFrontmatter", () => {
  it("读头里的键值，支持多行折叠", () => {
    const r = splitFrontmatter("---\nname: demo\ndescription: >\n  第一行\n  第二行\n---\n正文");
    expect(r.meta.name).toBe("demo");
    expect(r.meta.description).toBe("第一行 第二行");
    expect(r.body).toBe("正文");
  });
});

describe("importGithubRepo", () => {
  it("没有目录文件的仓库：直接扫出技能（带附带文件）、MCP、命令、规则", async () => {
    const f = fakeGithub({
      "me/stuff": {
        "skills/review/SKILL.md": "---\nname: code-review\ndescription: 审代码\n---\n# 步骤\n先看 diff",
        "skills/review/scripts/lint.sh": "echo hi",
        ".mcp.json": JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "fs-mcp"] } } }),
        "commands/ship.md": "---\ndescription: 发布\n---\n帮我发布 $ARGUMENTS",
        ".cursor/rules/style.mdc": "---\ndescription: 代码风格\n---\n用两个空格缩进",
        "README.md": "hello",
      },
    });
    const r = await importGithubRepo(f, { owner: "me", repo: "stuff", dir: "" }, "stuff", noDbx);
    const kinds = r.entries.map(e => e.kind).sort();
    expect(kinds).toEqual(["action", "mcp", "rule", "skill"]);
    const skill = r.entries.find(e => e.kind === "skill")!;
    expect(skill.install).toMatchObject({ kind: "skill", name: "code-review", description: "审代码" });
    expect((skill.install as any).files).toEqual([{ path: "scripts/lint.sh", url: expect.stringContaining("raw.githubusercontent.com/me/stuff/") }]);
    const action = r.entries.find(e => e.kind === "action")!;
    expect((action.install as any).prompt).toBe("帮我发布 {{input}}");
    expect(r.entries.every(e => e.source === "stuff")).toBe(true);
  });

  it("Claude Code 的 marketplace.json：插件指向本仓库子目录", async () => {
    const f = fakeGithub({
      "me/market": {
        ".claude-plugin/marketplace.json": JSON.stringify({
          name: "m",
          plugins: [{ name: "helper", description: "助手", source: "./plugins/helper", category: "dev" }],
        }),
        "plugins/helper/skills/a/SKILL.md": "---\nname: a\ndescription: 技能 A\n---\n正文 A",
        "plugins/helper/commands/go.md": "去做 $ARGUMENTS",
        "plugins/other/skills/b/SKILL.md": "---\nname: b\ndescription: 技能 B\n---\n正文 B",
      },
    });
    const r = await importGithubRepo(f, { owner: "me", repo: "market", dir: "" }, "market", noDbx);
    expect(r.entries.map(e => e.name).sort()).toEqual(["a", "go"]); // other 没被市场收录，不该出现
    expect(r.entries.every(e => e.id.startsWith("helper/"))).toBe(true);
    expect(r.entries[0].tags).toContain("helper");
  });

  it("Claude 市场里指向别的 GitHub 仓库的插件会被展开", async () => {
    const f = fakeGithub({
      "me/market": {
        ".claude-plugin/marketplace.json": JSON.stringify({ plugins: [{ name: "ext", description: "外部", source: { source: "github", repo: "them/tool" } }] }),
      },
      "them/tool": { "SKILL.md": "---\nname: tool\ndescription: 工具技能\n---\n用法" },
    });
    const r = await importGithubRepo(f, { owner: "me", repo: "market", dir: "" }, "market", noDbx);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ kind: "skill", id: "ext/skill-tool" });
    expect((r.entries[0].install as any).files).toBeUndefined(); // 仓库根的 SKILL.md 不带整个仓库
  });

  it("仓库自带 DBX 目录：交给 DBX 解析", async () => {
    const f = fakeGithub({ "me/dbx": { "catalog/index.json": JSON.stringify({ format: 1, plugins: [{ id: "x", name: "X", versions: [] }] }) } });
    let got: unknown;
    const r = await importGithubRepo(f, { owner: "me", repo: "dbx", dir: "" }, "dbx", json => {
      got = json;
      return [];
    });
    expect(got).toBeTruthy();
    expect(r.entries).toEqual([]);
  });

  it("插件仓库模式（catalogOnly）：只认 DBX 目录；技能 / MCP 仓库说明「不是插件」，不去扫描", async () => {
    const skills = fakeGithub({ "me/stuff": { "skills/a/SKILL.md": "---\nname: a\ndescription: d\n---\n正文" } });
    await expect(importGithubRepo(skills, { owner: "me", repo: "stuff", dir: "" }, "x", noDbx, { catalogOnly: true })).rejects.toThrow(/不是插件/);
    const claude = fakeGithub({ "me/m": { ".claude-plugin/marketplace.json": JSON.stringify({ plugins: [{ name: "p", description: "d", source: "./p" }] }) } });
    await expect(importGithubRepo(claude, { owner: "me", repo: "m", dir: "" }, "x", noDbx, { catalogOnly: true })).rejects.toThrow(/不是插件/);
    const dsh = fakeGithub({ "me/dsh": { "package.json": "{}", "src/index.js": "x" } });
    await expect(importGithubRepo(dsh, { owner: "me", repo: "dsh", dir: "" }, "x", noDbx, { catalogOnly: true })).rejects.toThrow(/没找到插件/);
    const dbx = fakeGithub({ "me/dbx": { "catalog/index.json": JSON.stringify({ format: 1, plugins: [{ id: "x", name: "X", versions: [] }] }) } });
    let got = false;
    await importGithubRepo(dbx, { owner: "me", repo: "dbx", dir: "" }, "x", () => ((got = true), []), { catalogOnly: true });
    expect(got).toBe(true);
  });

  it("空仓库（GitHub 返回 409）：作为插件仓库是「还没有插件」，不报错；导入技能时才说没内容", async () => {
    const empty = (async (input: any) => (String(input).startsWith("https://api.github.com/") ? new Response('{"message":"Git Repository is empty."}', { status: 409 }) : new Response("", { status: 404 }))) as unknown as typeof fetch;
    const r = await importGithubRepo(empty, { owner: "me", repo: "empty", dir: "" }, "x", json => ((json as any).plugins as any[]).map(() => ({}) as any), { catalogOnly: true });
    expect(r.entries).toEqual([]);
    await expect(importGithubRepo(empty, { owner: "me", repo: "empty", dir: "" }, "x", noDbx)).rejects.toThrow(/没找到本软件能用的内容/);
  });

  it("什么都没有（比如给 DSH 用的插件仓库）：说清楚原因", async () => {
    const f = fakeGithub({ "me/dsh": { "package.json": "{}", "src/index.js": "x" } });
    await expect(importGithubRepo(f, { owner: "me", repo: "dsh", dir: "" }, "dsh", noDbx)).rejects.toThrow(/没找到本软件能用的内容/);
  });

  it("GitHub API 被限流时，改走 jsDelivr 读清单和文件", async () => {
    const files: Record<string, string> = { "skills/x/SKILL.md": "---\nname: x\ndescription: 技能 X\n---\n正文", "skills/x/ref.md": "资料" };
    const f = (async (input: any) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) return new Response("{}", { status: 403 });
      if (url.startsWith("https://raw.githubusercontent.com/")) throw new Error("连不上"); // 国内常见
      if (url.startsWith("https://data.jsdelivr.com/")) return new Response(JSON.stringify({ files: Object.keys(files).map(n => ({ name: `/${n}` })) }));
      const m = /^https:\/\/cdn\.jsdelivr\.net\/gh\/me\/cdn@HEAD\/(.+)$/.exec(url);
      return m && files[decodeURIComponent(m[1])] !== undefined ? new Response(files[decodeURIComponent(m[1])]) : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const r = await importGithubRepo(f, { owner: "me", repo: "cdn", dir: "" }, "cdn", noDbx);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ kind: "skill", name: "x" });
    expect((r.entries[0].install as any).files).toHaveLength(1);
  });

  it("仓库不存在 / 被限流给人话", async () => {
    await expect(importGithubRepo(fakeGithub({}), { owner: "no", repo: "pe", dir: "" }, "x", noDbx)).rejects.toThrow(/找不到这个仓库/);
    const limited = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    await expect(importGithubRepo(limited, { owner: "a", repo: "b", dir: "" }, "x", noDbx)).rejects.toThrow(/限制了访问/);
  });
});
