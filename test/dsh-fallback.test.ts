import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, expect, it } from "vitest";
import { DshPlugins } from "../desktop/main/dsh-host";
import { netError } from "../desktop/main/neterr";
import { foreignId, type PluginEntry } from "../desktop/shared/plugins";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 最小的 tar（ustar）+ gzip：最外层目录名随便（GitHub 的是 仓库名-提交号/） */
function tgz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(`repo-abc123/${name}`, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const mk = (pkg: string, files: Record<string, string>, version = "0.0.0"): { h: DshPlugins; e: PluginEntry; calls: string[] } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-fb-"));
  dirs.push(dir);
  const calls: string[] = [];
  const f = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://api.github.com/")) return new Response("{}", { status: 403 }); // 匿名限额用光
    if (url.startsWith("https://data.jsdelivr.com/")) return new Response("", { status: 403 });
    if (url.startsWith("https://codeload.github.com/o/r/tar.gz/")) return new Response(new Uint8Array(tgz(files)));
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const h = new DshPlugins({ dir, consentFile: path.join(dir, "c.json"), fetchImpl: f });
  const e = { key: "k", id: foreignId("dsh", pkg), name: pkg, kind: "dsh", ecosystem: "dsh", description: "", tags: [], source: "t", install: { kind: "dsh", pkg, version, source: { type: "git", url: "https://github.com/o/r", commit: "a".repeat(40) } } } as PluginEntry;
  return { h, e, calls };
};

it("GitHub 文件清单接口被限流：改下载整库压缩包，照样装好；列表里的版本和插件自己的版本分开记", async () => {
  const { h, e, calls } = mk("fb-plugin", {
    "package.json": JSON.stringify({ name: "fb-plugin", version: "0.4.2", dsh: {}, main: "index.js" }),
    "index.js": `exports.name = "fb"; exports.inject = ["tools"]; exports.apply = ctx => ctx.tools.register({ name: "x", description: "d", parameters: {}, execute: async () => "ok" });`,
  });
  expect(await h.install(e)).toBe("0.4.2");
  expect(calls.some(u => u.startsWith("https://codeload.github.com/o/r/tar.gz/"))).toBe(true);
  const info = h.localInfo()[e.id];
  expect(info).toMatchObject({ version: "0.4.2", listed: "0.0.0" }); // 目录里登记的是 0.0.0，不能因为不一样就一直提示「可更新」
  expect(h.noteOf(e.id)).toBeUndefined();
});

it("压缩包里插件在子目录（索引没写目录）也能找到", async () => {
  const { h, e } = mk("fb-sub", {
    "README.md": "x",
    "plugins/dsh/package.json": JSON.stringify({ name: "fb-sub-dsh", version: "1.0.0", dsh: {}, main: "index.js" }),
    "plugins/dsh/index.js": `exports.name = "s"; exports.apply = () => {}; /* defineTool */`,
  });
  expect(await h.install(e)).toBe("1.0.0");
});

it("代码里没碰「工具」和「命令」：装得上，但提醒它多半没用", async () => {
  const { h, e } = mk("fb-ui", {
    "package.json": JSON.stringify({ name: "fb-ui", version: "1.0.0", dsh: {}, main: "index.js" }),
    "index.js": `exports.name = "ui"; exports.apply = () => {};`,
  });
  await h.install(e);
  expect(h.noteOf(e.id)).toMatch(/没发现这个插件提供 AI 工具或命令/);
  expect(h.localInfo()[e.id].summary).toContain("注意：");
});

it("网络报错换成人话", () => {
  expect(netError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toContain("网络超时");
  expect(netError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toContain("域名解析失败");
  expect(netError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }))).toContain("ECONNRESET");
  expect(netError(new Error("已经是中文的错误"))).toBe("已经是中文的错误");
  expect(netError(new Error("HTTP 500"))).toBe("HTTP 500");
});

it("接口被限流时，技能仓库（有 SKILL.md、没有 package.json）直接说明，不去下整库压缩包", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-fb-"));
  dirs.push(dir);
  const calls: string[] = [];
  const f = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://api.github.com/") || url.startsWith("https://data.jsdelivr.com/")) return new Response("{}", { status: 403 });
    if (url.endsWith("/SKILL.md")) return new Response("", { status: 200 });
    if (url.startsWith("https://raw.githubusercontent.com/")) return new Response("", { status: 404 });
    return new Response(new Uint8Array(tgz({ "SKILL.md": "x" })));
  }) as typeof fetch;
  const h = new DshPlugins({ dir, consentFile: path.join(dir, "c.json"), fetchImpl: f });
  const e = { key: "k", id: foreignId("dsh", "skill-repo"), name: "skill-repo", kind: "dsh", ecosystem: "dsh", description: "", tags: [], source: "t", install: { kind: "dsh", pkg: "skill-repo", version: "0.0.0", source: { type: "git", url: "https://github.com/o/r", commit: "b".repeat(40) } } } as PluginEntry;
  await expect(h.install(e)).rejects.toThrow(/技能（SKILL\.md）仓库/);
  expect(calls.some(u => u.startsWith("https://codeload.github.com/"))).toBe(false);
});
