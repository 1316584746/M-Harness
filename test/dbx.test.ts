import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DbxBridge, dbxDataDir, findDbxMcp, scanDbxPlugins } from "../desktop/main/dbx";
import { DBX_SOURCE, applyInstall, dbxBridgeOn, dbxInstallLink, dbxTarget, parseDbxCatalog, parseMarketplace, setDbxBridge } from "../desktop/shared/plugins";

const art = (target: string, v = "1.0.0") => ({ target, url: `https://dl.dbxio.com/plugins/a.b/${v}/a.b-${v}-${target}.dbxp`, sha256: "ab".repeat(32), size: 123, signingKeyId: "k" });
const catalog = {
  catalogVersion: 1,
  plugins: [
    {
      id: "a.b",
      name: "Alpha",
      description: "english",
      publisher: "bob",
      tags: ["x", "y"],
      permissions: ["host.ai"],
      source: "https://github.com/bob/alpha/tree/v1.1.0",
      homepage: "https://example.com",
      license: "MIT",
      latestVersion: "1.1.0",
      versions: [
        { version: "1.1.0", releasedAt: "2026-10-24T17:28:43.780Z", artifacts: [art("darwin-arm64", "1.1.0"), art("windows-x64", "1.1.0")] },
        { version: "1.0.0", releasedAt: "2026-10-01T00:00:00Z", artifacts: [art("windows-x64")] },
      ],
      localizations: { "zh-CN": { name: "阿尔法", description: "中文介绍" } },
    },
    { id: "c.d", name: "Only Mac", description: "d", latestVersion: "0.1.0", versions: [{ version: "0.1.0", artifacts: [art("darwin-arm64", "0.1.0")] }] },
    { id: "bad id!", name: "x", description: "y" },
    { id: "a.b", name: "dup", description: "dup" },
    "oops",
  ],
};

describe("DBX 插件目录", () => {
  it("解析：中文名、最新版本、当前系统的安装包、仓库地址", () => {
    const list = parseDbxCatalog(catalog, "windows-x64");
    expect(list.map(e => e.id)).toEqual(["a.b", "c.d"]);
    const a = list[0];
    expect(a).toMatchObject({ key: `${DBX_SOURCE}:a.b`, name: "阿尔法", description: "中文介绍", kind: "dbx", author: "bob", version: "1.1.0", updated: "2026-10-24", license: "MIT", source: DBX_SOURCE });
    expect(a.repo).toBe("https://github.com/bob/alpha");
    expect(a.install).toMatchObject({ kind: "dbx", dbxId: "a.b", permissions: ["host.ai"], size: 123 });
    expect((a.install as any).url).toContain("1.1.0-windows-x64.dbxp");
  });

  it("没有当前系统安装包的照样列出，只是没有下载地址", () => {
    const c = parseDbxCatalog(catalog, "windows-x64")[1];
    expect((c.install as any).url).toBeUndefined();
    expect(parseDbxCatalog(catalog, "darwin-arm64")[1].install).toMatchObject({ url: expect.stringContaining("darwin-arm64") });
  });

  it("英文界面用原文", () => {
    expect(parseDbxCatalog(catalog, "windows-x64", "en")[0].name).toBe("Alpha");
  });

  it("格式不对时报错", () => {
    expect(() => parseDbxCatalog({}, "windows-x64")).toThrow();
  });

  it("目标平台名", () => {
    expect(dbxTarget("win32", "x64")).toBe("windows-x64");
    expect(dbxTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(dbxTarget("linux", "x64")).toBe("linux-x64");
  });
});

describe("dbx:// 安装链接", () => {
  const ok = "https://dl.dbxio.com/plugins/a.b/1.0.0/a.b-1.0.0-windows-x64.dbxp";
  it("只认官方下载域名的 .dbxp", () => {
    expect(dbxInstallLink(ok)).toBe(`dbx://plugins/install?url=${encodeURIComponent(ok)}`);
    expect(dbxInstallLink("https://evil.com/a.dbxp")).toBeNull();
    expect(dbxInstallLink("http://dl.dbxio.com/a.dbxp")).toBeNull();
    expect(dbxInstallLink("https://dl.dbxio.com/a.zip")).toBeNull();
    expect(dbxInstallLink("not a url")).toBeNull();
  });
});

describe("本机 DBX", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dbx-"));
  const mk = (root: string, id: string, ver: string) => {
    const d = path.join(root, "plugins", id, "versions", ver);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "manifest.json"), "{}");
  };

  it("扫已装的插件，取最高版本，跳过隐藏目录和不完整的", () => {
    const root = tmp();
    mk(root, "io.dbx.ssh", "0.7.9");
    mk(root, "io.dbx.ssh", "0.7.13");
    mk(root, "io.dbx.ssh", "0.7.2");
    mk(root, "x.y", "1.0.0");
    fs.mkdirSync(path.join(root, "plugins", ".runtime"), { recursive: true });
    fs.mkdirSync(path.join(root, "plugins", "broken", "versions", "1.0.0"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugins", "file.json"), "{}");
    expect(scanDbxPlugins(root)).toEqual({ "io.dbx.ssh": "0.7.13", "x.y": "1.0.0" });
    expect(scanDbxPlugins(path.join(root, "nope"))).toEqual({});
  });

  it("各系统的数据目录", () => {
    expect(dbxDataDir("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")).toBe(path.join("C:\\Users\\u\\AppData\\Roaming", "com.dbx.app"));
    expect(dbxDataDir("darwin", {}, "/Users/u")).toBe(path.join("/Users/u", "Library", "Application Support", "com.dbx.app"));
    expect(dbxDataDir("linux", {}, "/home/u")).toBe(path.join("/home/u", ".local", "share", "com.dbx.app"));
  });

  it("找 DBX 的 MCP 组件", () => {
    const appdata = tmp();
    expect(findDbxMcp("win32", "x64", { APPDATA: appdata }, appdata)).toBeUndefined();
    const exe = path.join(appdata, "npm", "node_modules", "@dbx-app", "mcp-server", "node_modules", "@dbx-app", "mcp-win32-x64", "bin", "dbx-mcp.exe");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "");
    expect(findDbxMcp("win32", "x64", { APPDATA: appdata }, appdata)).toEqual({ command: exe, args: [] });
  });

  it("DbxBridge：目录有缓存；官方站连不上时退回 GitHub；全失败才报错", async () => {
    const calls: string[] = [];
    let failOfficial = true;
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes("dl.dbxio.com") && failOfficial) throw new Error("boom");
      return new Response(JSON.stringify(catalog), { status: 200 });
    }) as unknown as typeof fetch;
    const root = tmp();
    mk(root, "a.b", "1.0.0");
    const b = new DbxBridge(fetchImpl, { dataDir: root, platform: "win32", arch: "x64", env: { APPDATA: root } });
    expect((await b.catalog()).length).toBe(2);
    expect(calls.some(u => u.includes("raw.githubusercontent.com"))).toBe(true);
    const n = calls.length;
    await b.catalog();
    expect(calls.length).toBe(n); // 命中缓存
    expect(b.info()).toMatchObject({ appFound: true, plugins: { "a.b": "1.0.0" } });

    const dead = new DbxBridge((async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch, { dataDir: root });
    await expect(dead.catalog()).rejects.toThrow("offline");
    // 指定了目录地址时（测试 / 内网镜像）不再退回 GitHub
    const urls: string[] = [];
    const mirror = new DbxBridge((async (u: string) => (urls.push(u), Promise.reject(new Error("x")))) as unknown as typeof fetch, { dataDir: root, catalogUrl: "http://m/c.json" });
    await expect(mirror.catalog()).rejects.toThrow();
    expect(urls).toEqual(["http://m/c.json"]);
    failOfficial = false;
  });

  it("本机没装 DBX 时 appFound 为 false", () => {
    const b = new DbxBridge(fetch, { dataDir: path.join(tmp(), "none") });
    expect(b.info().appFound).toBe(false);
  });
});

describe("DBX 桥接开关", () => {
  const spec = { command: "dbx-mcp", args: [] as string[] };
  it("打开：加进 mcpServers；已有就只打开，不改用户的命令", () => {
    const cfg: any = {};
    expect(dbxBridgeOn(cfg)).toBe(false);
    setDbxBridge(cfg, true, spec);
    expect(cfg.mcpServers.dbx).toMatchObject({ command: "dbx-mcp", enabled: true, permission: "confirm" });
    expect(dbxBridgeOn(cfg)).toBe(true);
    setDbxBridge(cfg, false);
    expect(dbxBridgeOn(cfg)).toBe(false);
    cfg.mcpServers.dbx.command = "mine";
    setDbxBridge(cfg, true, spec);
    expect(cfg.mcpServers.dbx.command).toBe("mine");
    expect(dbxBridgeOn(cfg)).toBe(true);
  });
  it("没有命令又没配置过时打不开", () => {
    expect(() => setDbxBridge({}, true)).toThrow();
  });
});

describe("DBX 插件不走 Harness 自己的安装", () => {
  it("插件源 JSON 里不能声明 dbx 类型", () => {
    const r = parseMarketplace({ plugins: [{ id: "x", name: "x", description: "x", kind: "dbx", install: {} }] }, "s");
    expect(r.entries).toEqual([]);
    expect(r.skipped[0]).toContain("kind");
  });
  it("applyInstall 拒绝 dbx 条目", () => {
    const e = parseDbxCatalog(catalog, "windows-x64")[0];
    expect(() => applyInstall({}, e)).toThrow("DBX");
  });
});
