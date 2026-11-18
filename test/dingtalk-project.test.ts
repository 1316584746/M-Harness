import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { Runtime } from "../src/runtime";
import { DT_READ_COMMANDS, DT_WRITE_COMMANDS, dingtalkProjectTools } from "../src/tools/dingtalk-project";

let script: string;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-"));
  script = path.join(dir, "fake-dws.cjs");
  fs.writeFileSync(
    script,
    `const a = process.argv.slice(2);
if (a[0] === "fail") { console.error("boom"); process.exit(3); }
console.log(JSON.stringify(a));`,
  );
});

const cfg = () => ({ bin: process.execPath, binArgs: [script], write: false });
const ctx = { signal: new AbortController().signal, root: "." };
const byName = (tools: ReturnType<typeof dingtalkProjectTools>, n: string) => tools.find(t => t.name === n)!;

describe("钉钉项目管理工具", () => {
  it("默认只有读类；write=true 才有写类", () => {
    const r = dingtalkProjectTools(cfg());
    expect(r.map(t => t.name)).toEqual(["dingtalk_project_inspect", "dingtalk_project_read"]);
    expect(r.every(t => t.risk === "read")).toBe(true);
    expect(byName(dingtalkProjectTools({ ...cfg(), write: true }), "dingtalk_project_write").risk).toBe("write");
  });

  it("读工具：参数逐个传，自动带 --format=json，特殊字符不会被 shell 解释", async () => {
    const t = byName(dingtalkProjectTools(cfg()), "dingtalk_project_read");
    const q = "a; rm -rf / && echo $HOME";
    const out = JSON.parse(await t.run({ command: "todo task list", args: { status: "false", size: 20, query: q } }, ctx));
    expect(out).toEqual(["todo", "task", "list", "--status=false", "--size=20", `--query=${q}`, "--format=json"]);
    const own = JSON.parse(await t.run({ command: "aisearch person", args: { format: "table" } }, ctx));
    expect(own).toEqual(["aisearch", "person", "--format=table"]);
  });

  it("读工具拒绝写类 / 删除 / 未知命令，格式不对直接报错", async () => {
    const t = byName(dingtalkProjectTools(cfg()), "dingtalk_project_read");
    await expect(t.run({ command: "todo task create", args: {} }, ctx)).rejects.toThrow(/白名单/);
    await expect(t.run({ command: "todo task delete", args: {} }, ctx)).rejects.toThrow(/白名单/);
    await expect(t.run({ command: "auth login", args: {} }, ctx)).rejects.toThrow(/白名单/);
    await expect(t.run({ command: "todo", args: {} }, ctx)).rejects.toThrow(/格式/);
    await expect(t.run({ command: "todo task list; calc", args: {} }, ctx)).rejects.toThrow(/格式/);
  });

  it("写工具只允许写类命令", async () => {
    const t = byName(dingtalkProjectTools({ ...cfg(), write: true }), "dingtalk_project_write");
    await expect(t.run({ command: "todo task list", args: {} }, ctx)).rejects.toThrow(/白名单/);
    await expect(t.run({ command: "todo task delete", args: { "task-id": "1" } }, ctx)).rejects.toThrow(/白名单/);
    const out = JSON.parse(await t.run({ command: "todo task create", args: { title: "修复线上Bug", executors: "u1,u2", priority: 40 } }, ctx));
    expect(out.slice(0, 3)).toEqual(["todo", "task", "create"]);
    expect(out).toContain("--title=修复线上Bug");
  });

  it("inspect 转成 --help，且只允许白名单命令", async () => {
    const t = byName(dingtalkProjectTools(cfg()), "dingtalk_project_inspect");
    expect(JSON.parse(await t.run({ command: "todo task create" }, ctx))).toEqual(["todo", "task", "create", "--help"]);
    await expect(t.run({ command: "todo task delete" }, ctx)).rejects.toThrow();
  });

  it("CLI 失败时返回退出码；找不到可执行文件给出提示", async () => {
    const tools = dingtalkProjectTools({ ...cfg(), binArgs: [script, "fail"] });
    expect(await byName(tools, "dingtalk_project_read").run({ command: "todo task list" }, ctx)).toContain("退出码 3");
    const missing = dingtalkProjectTools({ bin: "definitely-not-a-real-binary-xyz" });
    expect(await byName(missing, "dingtalk_project_read").run({ command: "todo task list" }, ctx)).toContain("启动 definitely-not-a-real-binary-xyz 失败");
  });

  it("白名单里没有删除 / 认证 / 配置类命令", () => {
    for (const c of [...DT_READ_COMMANDS, ...DT_WRITE_COMMANDS]) expect(c).not.toMatch(/(^auth|^config|\bdelete\b|\bremove-attachment\b|^upgrade)/);
  });
});

describe("Runtime 装配", () => {
  it("配置了 integrations.dingtalkProject 才暴露工具；办公通道只读时写类被拒", () => {
    expect(new Runtime(parseConfig({})).tools.some(t => t.name.startsWith("dingtalk_project"))).toBe(false);
    const rt = new Runtime(parseConfig({ integrations: { dingtalk: { bin: "dws" }, dingtalkProject: { write: true } } }));
    const w = rt.tools.find(t => t.name === "dingtalk_project_write")!;
    const r = rt.tools.find(t => t.name === "dingtalk_project_read")!;
    expect(w && r).toBeTruthy();
    expect(rt.guardFor("channel").check(w, {}).action).toBe("deny");
    expect(rt.guardFor("channel").check(r, {}).action).toBe("allow");
    expect(rt.guardFor("local").check(w, {}).action).toBe("ask");
  });
});
