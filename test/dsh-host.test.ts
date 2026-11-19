import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { DshPlugins } from "../desktop/main/dsh-host";
import { PluginAi } from "../desktop/main/plugin-ai";
import { foreignId, type PluginEntry } from "../desktop/shared/plugins";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-host-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 最小的 tar（ustar）+ gzip，npm 包的目录名固定是 package/ */
function tgz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(`package/${name}`, 0, 100, "utf8");
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

const REG = "https://reg.example";

/** 假的 npm 仓库：fx-plugin 依赖 dep-a */
function fakeNpm(opts: { corrupt?: boolean } = {}): typeof fetch {
  const pkgs: Record<string, { version: string; deps?: Record<string, string>; files: Record<string, string> }> = {
    "fx-plugin": {
      version: "1.2.3",
      deps: { "dep-a": "^1.0.0" },
      files: {
        "package.json": JSON.stringify({ name: "fx-plugin", version: "1.2.3", dsh: {}, main: "index.js", dependencies: { "dep-a": "^1.0.0" } }),
        "index.js": `
const dep = require("dep-a");
exports.name = "fx-plugin";
exports.inject = ["tools", "commands"];
exports.apply = ctx => {
  ctx.tools.register({
    name: "shout",
    description: "把文字喊出来",
    parameters: { text: { type: "string", required: true } },
    readOnly: true,
    execute: async args => dep(args.text),
  });
  ctx.commands.register({ name: "hi", description: "打招呼", handler: async ({ input }) => "你好 " + input });
};
`,
      },
    },
    "dep-a": { version: "1.0.5", files: { "package.json": JSON.stringify({ name: "dep-a", version: "1.0.5", main: "i.js" }), "i.js": "module.exports = s => String(s).toUpperCase() + '!';" } },
    "needs-core": {
      version: "1.0.0",
      files: {
        "package.json": JSON.stringify({ name: "needs-core", version: "1.0.0", dsh: {}, main: "index.js", type: "module" }),
        "index.js": `import { defineTool } from "@deepseek-ai/dsh-tools";\nimport {\n  CompactionEngine,\n} from "@deepseek-ai/dsh-compaction";\nexport const name = "needs-core";`,
      },
    },
    "needs-ui": {
      version: "1.0.0",
      files: {
        "package.json": JSON.stringify({ name: "needs-ui", version: "1.0.0", dsh: {}, main: "index.js" }),
        "index.js": `exports.name = "needs-ui"; exports.inject = ["tools", "notThere"]; exports.apply = () => {};`,
      },
    },
  };
  return (async (input: any) => {
    const url = String(input);
    const m = /^https:\/\/reg\.example\/([^/]+)(?:\/-\/(.+)\.tgz)?$/.exec(url);
    if (!m) return new Response("", { status: 404 });
    const p = pkgs[decodeURIComponent(m[1])];
    if (!p) return new Response("", { status: 404 });
    const name = decodeURIComponent(m[1]);
    const buf = tgz(p.files);
    if (m[2]) return new Response(new Uint8Array(buf));
    const integrity = `sha512-${crypto
      .createHash("sha512")
      .update(opts.corrupt ? Buffer.from("x") : buf)
      .digest("base64")}`;
    return new Response(JSON.stringify({ name, "dist-tags": { latest: p.version }, versions: { [p.version]: { name, version: p.version, dependencies: p.deps, dist: { tarball: `${REG}/${name}/-/${name}-${p.version}.tgz`, integrity } } } }));
  }) as typeof fetch;
}

const entry = (pkg: string, version: string): PluginEntry => ({
  key: `测试:${foreignId("dsh", pkg)}`,
  id: foreignId("dsh", pkg),
  name: pkg,
  kind: "dsh",
  ecosystem: "dsh",
  description: "测试插件",
  tags: [],
  source: "测试",
  install: { kind: "dsh", pkg, version, source: { type: "npm" } },
});

const make = (opts: { corrupt?: boolean } = {}) => {
  const dir = tmp();
  return new DshPlugins({ dir, consentFile: path.join(dir, "consent.json"), fetchImpl: fakeNpm(opts), npm: { registries: [REG] } });
};

describe("DSH 插件：安装", () => {
  it("从 npm 装：连依赖一起装好，登记版本；没确认信任前不运行", async () => {
    const h = make();
    expect(await h.install(entry("fx-plugin", "1.2.3"))).toBe("1.2.3");
    const [m] = h.installed();
    expect(m).toMatchObject({ id: "dsh:fx-plugin", pkg: "fx-plugin", version: "1.2.3" });
    expect(h.localInfo()["dsh:fx-plugin"]).toMatchObject({ ecosystem: "dsh", version: "1.2.3" });
    const dep = path.join(h["o"].dir, "plugins", "fx-plugin", "node_modules", "dep-a", "package.json");
    expect(fs.existsSync(dep)).toBe(true);
    expect(h.isTrusted("dsh:fx-plugin")).toBe(false);
    await expect(h.aiTools("dsh:fx-plugin")).rejects.toThrow("信任");
    expect(h.aiPlugins()).toMatchObject([{ id: "dsh:fx-plugin", trusted: false, ecosystem: "dsh" }]);
  });

  it("下载内容和 npm 登记的指纹对不上：拒绝安装，不留半成品", async () => {
    const h = make({ corrupt: true });
    await expect(h.install(entry("fx-plugin", "1.2.3"))).rejects.toThrow(/校验没通过/);
    expect(h.installed()).toEqual([]);
    expect(fs.readdirSync(path.join(h["o"].dir, "plugins")).filter(n => !n.startsWith("."))).toEqual([]);
  });

  it("代码里 import 了本软件没有的 DSH 内部包（如 dsh-compaction）：拒绝安装并说清原因；dsh-tools 这种有的不算", async () => {
    const h = make();
    await expect(h.install(entry("needs-core", "1.0.0"))).rejects.toThrow(/dsh-compaction.*已取消安装/);
    expect(h.installed()).toEqual([]);
  });

  it("卸载：删代码、记录和信任", async () => {
    const h = make();
    await h.install(entry("fx-plugin", "1.2.3"));
    h.trust("dsh:fx-plugin");
    expect(await h.uninstall("dsh:fx-plugin")).toBe(true);
    expect(h.installed()).toEqual([]);
    expect(fs.existsSync(path.join(h["o"].dir, "plugins", "fx-plugin"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(h["o"].consentFile, "utf8"))).toEqual({});
    expect(await h.uninstall("dsh:fx-plugin")).toBe(false);
  });
});

describe("DSH 插件：运行（真实的 Cordis 子进程）", () => {
  it("确认信任后：工具和命令能被读到、能调用；换版本要重新确认", async () => {
    const h = make();
    await h.install(entry("fx-plugin", "1.2.3"));
    expect(h.trust("dsh:fx-plugin")).toBe(true);
    try {
      const tools = await h.aiTools("dsh:fx-plugin");
      expect(tools.map(t => t.name).sort()).toEqual(["command_hi", "shout"]);
      const shout = tools.find(t => t.name === "shout")!;
      expect(shout.readOnly).toBe(true);
      expect(shout.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
      expect(await h.aiCall("dsh:fx-plugin", "shout", { text: "abc" })).toEqual({ content: [{ type: "text", text: "ABC!" }] });
      expect(await h.aiCall("dsh:fx-plugin", "command_hi", { input: "世界" })).toEqual({ content: [{ type: "text", text: "你好 世界" }] });
      await expect(h.aiCall("dsh:fx-plugin", "nope", {})).rejects.toThrow("没有这个工具");
      expect(h.installed()[0].tools).toBe(2);
    } finally {
      await h.stopAll();
    }
  }, 60_000);

  it("通过 PluginAi 交给模型：名字带插件 id，调用结果是文本", async () => {
    const h = make();
    await h.install(entry("fx-plugin", "1.2.3"));
    h.trust("dsh:fx-plugin");
    const ai = new PluginAi(() => h, path.join(h["o"].dir, "ai.json"));
    try {
      expect(ai.tools()).toEqual([]); // 还没开
      ai.setEnabled("dsh:fx-plugin", true);
      await ai.prepare();
      const list = ai.tools();
      const t = list.find(x => x.name.endsWith("__shout"))!;
      expect(t.name).toBe("plugin__dsh_fx-plugin__shout");
      expect(t.risk).toBe("read");
      const out = await t.run({ text: "ok" }, { signal: new AbortController().signal } as any);
      expect(out).toBe("OK!");
      expect((await ai.list())[0]).toMatchObject({ id: "dsh:fx-plugin", trusted: true, enabled: true, ecosystem: "dsh" });
    } finally {
      await h.stopAll();
    }
  }, 60_000);

  it("插件要求本软件没有的 DSH 服务：不启动它，把原因告诉用户", async () => {
    const h = make();
    await h.install(entry("needs-ui", "1.0.0"));
    h.trust("dsh:needs-ui");
    try {
      await expect(h.aiTools("dsh:needs-ui")).rejects.toThrow(/notThere/);
    } finally {
      await h.stopAll();
    }
  }, 60_000);

  it("更新到新版本后要重新确认信任", async () => {
    const h = make();
    await h.install(entry("fx-plugin", "1.2.3"));
    h.trust("dsh:fx-plugin");
    expect(h.isTrusted("dsh:fx-plugin")).toBe(true);
    const consent = JSON.parse(fs.readFileSync(h["o"].consentFile, "utf8"));
    consent["dsh:fx-plugin"].version = "1.0.0";
    fs.writeFileSync(h["o"].consentFile, JSON.stringify(consent));
    expect(h.isTrusted("dsh:fx-plugin")).toBe(false);
  });
});
