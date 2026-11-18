import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PluginHost } from "../desktop/main/pluginhost";

// 假的插件后台：按 JSON-RPC 一行一条，支持握手、回显、报错、主动通知、崩溃
const SIDECAR = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const id = process.env.FAKE_ID_OVERRIDE || process.env.DBX_PLUGIN_ID;
const send = o => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", l => {
  const m = JSON.parse(l);
  if (m.method === "plugin/initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, plugin: { id }, capabilities: ["x"] } });
  if (m.method === "echo/hello") return send({ jsonrpc: "2.0", id: m.id, result: { echo: m.params, dir: process.env.DBX_PLUGIN_DATA_DIR, pid: process.pid } });
  if (m.method === "boom") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "炸了" } });
  if (m.method === "emit") { send({ jsonrpc: "2.0", method: "tick", params: { n: 1 } }); return send({ jsonrpc: "2.0", id: m.id, result: true }); }
  if (m.method === "crash") process.exit(3);
  if (m.method === "hang") return;
  if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no method" } });
});
`;

let tmp: string;
let n = 0;

function install(id: string, o: { backend?: boolean; perms?: string[]; ui?: boolean } = {}) {
  const dir = path.join(tmp, "plugins", id, "versions", "1.0.0");
  fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "bin", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ui", "index.html"), "<!doctype html><html><head><title>t</title></head><body>hi</body></html>");
  fs.writeFileSync(path.join(dir, "ui", "app.js"), "console.log(1)");
  fs.writeFileSync(path.join(dir, "assets", "plugin.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  fs.writeFileSync(path.join(dir, "bin", "x", "sidecar.js"), SIDECAR);
  fs.writeFileSync(path.join(tmp, "secret.txt"), "秘密");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id,
      name: "假插件",
      version: "1.0.0",
      icon: "assets/plugin.svg",
      permissions: o.perms ?? [],
      entrypoints: { ...(o.backend === false ? {} : { backend: { executable: "bin/x/sidecar.js" } }), ...(o.ui === false ? {} : { ui: { root: "ui", entry: "ui/index.html" } }) },
      localizations: { en: { name: "Fake" } },
    }),
  );
}

function host(o: { onEvent?: (id: string, m: string, p: unknown) => void } = {}) {
  return new PluginHost({
    localDir: path.join(tmp, "plugins"),
    dataRoot: path.join(tmp, "data"),
    consentFile: path.join(tmp, "consent.json"),
    launch: exe => ({ command: process.execPath, args: [exe] }),
    onEvent: o.onEvent,
  });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plughost-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const hosts: PluginHost[] = [];
const mk = (...a: Parameters<typeof host>) => {
  const h = host(...a);
  hosts.push(h);
  return h;
};
afterEach(async () => {
  for (const h of hosts.splice(0)) h.stopAll();
  await new Promise(r => setTimeout(r, 150)); // 等子进程真正退出，Windows 上还占着目录
  const rm = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
  fs.rmSync(path.join(tmp, "plugins"), rm);
  fs.rmSync(path.join(tmp, "consent.json"), { force: true });
  fs.rmSync(path.join(tmp, "data"), rm);
});

describe("插件运行：列表与信任", () => {
  it("只列出带界面的插件，带图标；带后台的没确认前是未信任", () => {
    install("com.t.a");
    install("com.t.noui", { ui: false });
    install("com.t.pure", { backend: false });
    const h = mk();
    const l = h.list();
    expect(l.map(p => p.id).sort()).toEqual(["com.t.a", "com.t.pure"]);
    const a = l.find(p => p.id === "com.t.a")!;
    expect(a).toMatchObject({ name: "假插件", version: "1.0.0", backend: true, trusted: false });
    expect(a.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(l.find(p => p.id === "com.t.pure")!.trusted).toBe(true); // 没有本机程序，界面是隔离的，不用确认
    expect(h.trust("com.t.a")).toBe(true);
    expect(h.list().find(p => p.id === "com.t.a")!.trusted).toBe(true);
    expect(h.trust("com.t.nope")).toBe(false);
  });

  it("换版本要重新确认", () => {
    install("com.t.a");
    const h = mk();
    h.trust("com.t.a");
    const v2 = path.join(tmp, "plugins", "com.t.a", "versions", "2.0.0");
    fs.cpSync(path.join(tmp, "plugins", "com.t.a", "versions", "1.0.0"), v2, { recursive: true });
    expect(h.list()[0]).toMatchObject({ version: "2.0.0", trusted: false });
  });
});

describe("插件运行：界面文件", () => {
  it("入口页注入 dbxPlugin 和 CSP，只放行声明过的网络来源", async () => {
    install("com.t.a", { perms: ["host.network:https://leetcode.cn", "host.network:http://evil.com", "host.network:https://a.com/path"] });
    const r = mk().serve("harness-plugin://com.t.a/");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("window.dbxPlugin");
    expect(html).toContain("dbx-btn");
    expect(html.indexOf("window.dbxPlugin")).toBeLessThan(html.indexOf("<body>"));
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("connect-src 'self' https://leetcode.cn");
    expect(csp).not.toContain("evil.com");
    expect(csp).not.toContain("a.com");
    expect(csp).toContain("default-src 'none'");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("脚本等静态文件原样返回；主机名大小写不敏感", async () => {
    install("com.t.Mixed");
    const h = mk();
    const r = h.serve("harness-plugin://com.t.mixed/app.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    expect(await r.text()).toBe("console.log(1)");
  });

  it("不能跳出 ui 目录，也读不到别的插件和不存在的文件", () => {
    install("com.t.a");
    const h = mk();
    for (const p of ["../manifest.json", "..%2Fmanifest.json", "%2e%2e/manifest.json", "../../../../secret.txt", "..\\manifest.json"]) {
      const s = h.serve(`harness-plugin://com.t.a/${p}`).status;
      expect([403, 404]).toContain(s);
    }
    expect(h.serve("harness-plugin://com.t.a/nothing.js").status).toBe(404);
    expect(h.serve("harness-plugin://com.t.zzz/").status).toBe(404);
    expect(h.serve("not a url").status).toBe(400);
  });
});

describe("插件运行：后台程序", () => {
  it("没确认信任前不启动后台", async () => {
    install("com.t.a");
    const r = await mk().request("com.t.a", "backend.invoke", { method: "echo/hello" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("信任");
  });

  it("确认后：握手、调用、数据目录、错误原样带回", async () => {
    install("com.t.a");
    const h = mk();
    h.trust("com.t.a");
    const r = await h.request("com.t.a", "backend.invoke", { method: "echo/hello", params: { a: 1 } });
    expect(r.ok).toBe(true);
    const v = r.result as { echo: unknown; dir: string; pid: number };
    expect(v.echo).toEqual({ a: 1 });
    expect(v.dir).toBe(path.join(tmp, "data", "com.t.a"));
    // 第二次复用同一个进程
    expect(((await h.request("com.t.a", "backend.invoke", { method: "echo/hello" })).result as { pid: number }).pid).toBe(v.pid);
    const bad = await h.request("com.t.a", "backend.invoke", { method: "boom" });
    expect(bad).toEqual({ ok: false, error: "炸了" });
  });

  it("界面不能直接调 plugin/ host/ 开头的内部方法", async () => {
    install("com.t.a");
    const h = mk();
    h.trust("com.t.a");
    for (const m of ["plugin/initialize", "plugin/shutdown", "host/x", ""]) expect((await h.request("com.t.a", "backend.invoke", { method: m })).ok).toBe(false);
  });

  it("崩溃后下次调用自动重启；停止后也能再起来", async () => {
    install("com.t.a");
    const h = mk();
    h.trust("com.t.a");
    const pid1 = ((await h.request("com.t.a", "backend.invoke", { method: "echo/hello" })).result as { pid: number }).pid;
    const crash = await h.request("com.t.a", "backend.invoke", { method: "crash" });
    expect(crash.ok).toBe(false);
    expect(crash.error).toContain("退出");
    const pid2 = ((await h.request("com.t.a", "backend.invoke", { method: "echo/hello" })).result as { pid: number }).pid;
    expect(pid2).not.toBe(pid1);
    await h.stop("com.t.a");
    const pid3 = ((await h.request("com.t.a", "backend.invoke", { method: "echo/hello" })).result as { pid: number }).pid;
    expect(pid3).not.toBe(pid2);
  });

  it("超时会报错而不是一直挂着", async () => {
    install("com.t.a");
    const h = mk();
    h.trust("com.t.a");
    const r = await h.request("com.t.a", "backend.invoke", { method: "hang", timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("超时");
  });

  it("后台自称的身份和插件对不上就拒绝", async () => {
    install("com.t.a");
    const h = mk();
    h.trust("com.t.a");
    process.env.FAKE_ID_OVERRIDE = "com.other";
    try {
      const r = await h.request("com.t.a", "backend.invoke", { method: "echo/hello" });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("对不上");
    } finally {
      delete process.env.FAKE_ID_OVERRIDE;
    }
  });

  it("只有声明了 host.events 才把后台的通知转给界面", async () => {
    const got: string[] = [];
    install("com.t.a", { perms: ["host.events"] });
    install("com.t.b");
    const h = mk({ onEvent: (id, m) => got.push(`${id}:${m}`) });
    h.trust("com.t.a");
    h.trust("com.t.b");
    await h.request("com.t.a", "backend.invoke", { method: "emit" });
    await h.request("com.t.b", "backend.invoke", { method: "emit" });
    await new Promise(r => setTimeout(r, 100));
    expect(got).toEqual(["com.t.a:tick"]);
  });
});

describe("插件运行：宿主方法", () => {
  it("上下文、标题、资源只能读自己的 assets / ui", async () => {
    install("com.t.a");
    const h = mk();
    const ctx = (await h.request("com.t.a", "host.getContext", {})).result as { pluginId: string };
    expect(ctx.pluginId).toBe("com.t.a");
    expect((await h.request("com.t.a", "host.getTitle", {})).result).toBeNull();
    await h.request("com.t.a", "host.setTitle", { title: "标题" });
    expect((await h.request("com.t.a", "host.getTitle", {})).result).toBe("标题");
    expect((await h.request("com.t.a", "host.readAsset", { path: "assets/plugin.svg", url: true })).result).toMatch(/^data:image\/svg\+xml/);
    for (const p of ["manifest.json", "../../../secret.txt", "bin/x/sidecar.js"]) expect((await h.request("com.t.a", "host.readAsset", { path: p })).ok).toBe(false);
  });

  it("存储要声明 host.storage，有大小上限", async () => {
    install("com.t.a");
    install("com.t.s", { perms: ["host.storage"] });
    const h = mk();
    expect((await h.request("com.t.a", "host.storage.get", { key: "k" })).ok).toBe(false);
    expect((await h.request("com.t.s", "host.storage.get", { key: "k" })).result).toBeNull();
    await h.request("com.t.s", "host.storage.set", { key: "k", value: { a: [1, 2] } });
    expect((await h.request("com.t.s", "host.storage.get", { key: "k" })).result).toEqual({ a: [1, 2] });
    await h.request("com.t.s", "host.storage.delete", { key: "k" });
    expect((await h.request("com.t.s", "host.storage.get", { key: "k" })).result).toBeNull();
    expect((await h.request("com.t.s", "host.storage.set", { key: "big", value: "x".repeat(300 * 1024) })).ok).toBe(false);
    expect((await h.request("com.t.s", "host.storage.set", { key: "__proto__", value: 1 })).ok).toBe(false);
  });

  it("不认识的方法和已卸载的插件都明确报错", async () => {
    install("com.t.a");
    const h = mk();
    expect((await h.request("com.t.a", "host.openWorkbench", {})).error).toContain("暂不支持");
    expect((await h.request("com.t.gone", "host.getContext", {})).ok).toBe(false);
  });
});
