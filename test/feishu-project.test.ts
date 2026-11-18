import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { Runtime } from "../src/runtime";
import { feishuProjectStatus, feishuProjectTools, toFlags, READ_COMMANDS, WRITE_COMMANDS } from "../src/tools/feishu-project";

let script: string;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));
  script = path.join(dir, "fake-meegle.cjs");
  fs.writeFileSync(
    script,
    `const a = process.argv.slice(2);
if (a[0] === "auth" && a[1] === "status") { console.log(JSON.stringify({ authenticated: true, host: "project.feishu.cn" })); process.exit(0); }
if (a[0] === "fail") { console.error("boom"); process.exit(3); }
console.log(JSON.stringify(a));`,
  );
});

const cfg = () => ({ bin: process.execPath, binArgs: [script], write: false });
const ctx = { signal: new AbortController().signal, root: "." };
const byName = (tools: ReturnType<typeof feishuProjectTools>, n: string) => tools.find(t => t.name === n)!;

describe("toFlags", () => {
  it("把对象转成 --k=v，数组重复，布尔只带开关，对象转 JSON", () => {
    expect(toFlags({ "project-key": "p1", set: ["a=1", "b=2"], "auto-paginate": true, skip: false, fields: { x: 1 } as any, project_name: "x" })).toEqual([
      "--project-key=p1",
      "--set=a=1",
      "--set=b=2",
      "--auto-paginate",
      '--fields={"x":1}',
      "--project-name=x",
    ]);
  });
  it("拒绝非法参数名（防止夹带其它 flag）", () => {
    expect(() => toFlags({ "a b": "x" })).toThrow();
    expect(() => toFlags({ "x;rm": "x" })).toThrow();
  });
});

describe("feishu 项目工具", () => {
  it("默认只有读类工具；write=true 才有写类工具", () => {
    const r = feishuProjectTools(cfg());
    expect(r.map(t => t.name)).toEqual(["feishu_project_inspect", "feishu_project_my_todo", "feishu_project_read"]);
    expect(r.every(t => t.risk === "read")).toBe(true);
    const w = feishuProjectTools({ ...cfg(), write: true });
    expect(byName(w, "feishu_project_write").risk).toBe("write");
  });

  it("读工具：参数逐个传给 CLI，含特殊字符也不会被 shell 解释", async () => {
    const t = byName(feishuProjectTools(cfg()), "feishu_project_read");
    const mql = "SELECT `名称` FROM `空间`.`需求` WHERE `状态` = '进行中'; rm -rf / && echo $HOME";
    const out = JSON.parse(await t.run({ command: "workitem query", args: { "project-key": "p1", mql } }, ctx));
    expect(out).toEqual(["workitem", "query", "--project-key=p1", `--mql=${mql}`]);
  });

  it("读工具拒绝写类命令与未知命令", async () => {
    const t = byName(feishuProjectTools(cfg()), "feishu_project_read");
    await expect(t.run({ command: "comment add", args: {} }, ctx)).rejects.toThrow(/白名单/);
    await expect(t.run({ command: "auth login", args: {} }, ctx)).rejects.toThrow(/白名单/);
    await expect(t.run({ command: "workitem", args: {} }, ctx)).rejects.toThrow(/格式/);
  });

  it("写工具只允许写类命令", async () => {
    const t = byName(feishuProjectTools({ ...cfg(), write: true }), "feishu_project_write");
    await expect(t.run({ command: "workitem query", args: {} }, ctx)).rejects.toThrow(/白名单/);
    const out = JSON.parse(await t.run({ command: "comment add", args: { "project-key": "p", "work-item-id": "1", content: "hi" } }, ctx));
    expect(out[0]).toBe("comment");
  });

  it("my_todo 拼出正确参数；inspect 只允许白名单命令", async () => {
    const tools = feishuProjectTools(cfg());
    expect(JSON.parse(await byName(tools, "feishu_project_my_todo").run({ action: "overdue", page: 2 }, ctx))).toEqual(["mywork", "todo", "--action=overdue", "--page-num=2"]);
    expect(JSON.parse(await byName(tools, "feishu_project_inspect").run({ command: "workitem.query" }, ctx))).toEqual(["inspect", "workitem.query"]);
    await expect(byName(tools, "feishu_project_inspect").run({ command: "auth.login" }, ctx)).rejects.toThrow();
  });

  it("CLI 失败时把退出码和 stderr 返回给模型；找不到可执行文件时给出提示", async () => {
    // fake 脚本里第一个参数为 fail 时退出码 3：通过 binArgs 之外的 argv 触发
    const tools = feishuProjectTools({ ...cfg(), binArgs: [script, "fail"] });
    const out = await byName(tools, "feishu_project_my_todo").run({ action: "todo" }, ctx);
    expect(out).toContain("退出码 3");
    const missing = feishuProjectTools({ bin: "definitely-not-a-real-binary-xyz" });
    expect(await byName(missing, "feishu_project_my_todo").run({ action: "todo" }, ctx)).toContain("启动 definitely-not-a-real-binary-xyz 失败");
  });

  it("白名单里没有任何危险的认证/配置命令", () => {
    for (const c of [...READ_COMMANDS, ...WRITE_COMMANDS]) expect(c).not.toMatch(/^(auth|config|extension|ai-handoff|completion|telemetry)\b/);
  });

  it("status：读出登录状态", async () => {
    expect(await feishuProjectStatus(cfg())).toMatchObject({ installed: true, authenticated: true, host: "project.feishu.cn" });
    expect((await feishuProjectStatus({ bin: "definitely-not-a-real-binary-xyz" })).installed).toBe(false);
  });
});

describe("Runtime 装配", () => {
  it("配置了 integrations.feishuProject 才暴露工具；办公通道只读时写类被拒", () => {
    expect(new Runtime(parseConfig({})).tools.some(t => t.name.startsWith("feishu_project"))).toBe(false);
    const rt = new Runtime(parseConfig({ integrations: { feishuProject: { bin: "meegle", write: true } } }));
    const names = rt.tools.map(t => t.name);
    expect(names).toContain("feishu_project_read");
    expect(names).toContain("feishu_project_write");
    const w = rt.tools.find(t => t.name === "feishu_project_write")!;
    const r = rt.tools.find(t => t.name === "feishu_project_read")!;
    expect(rt.guardFor("channel").check(w, {}).action).toBe("deny");
    expect(rt.guardFor("channel").check(r, {}).action).toBe("allow");
    expect(rt.guardFor("local").check(w, {}).action).toBe("ask");
  });
});
