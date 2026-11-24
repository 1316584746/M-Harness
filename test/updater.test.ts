import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Backend } from "../desktop/main/backend";
import { compareVersions, parseRepo, Updater, type AutoUpdaterLike } from "../desktop/main/updater";
import type { UpdateStateDTO } from "../desktop/shared/api";

describe("版本比较 / 仓库解析", () => {
  it("compareVersions", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
  it("parseRepo", () => {
    expect(parseRepo("foo/bar")).toEqual({ owner: "foo", repo: "bar" });
    expect(parseRepo("https://github.com/foo/bar.git")).toEqual({ owner: "foo", repo: "bar" });
    expect(parseRepo("git@github.com:foo/bar.git")).toEqual({ owner: "foo", repo: "bar" });
    expect(parseRepo("")).toBeNull();
    expect(parseRepo("justname")).toBeNull();
  });
});

describe("Updater", () => {
  let server: http.Server;
  let base = "";
  let release: { status: number; body: any; apiStatus?: number } = { status: 404, body: {} };
  let hits = 0;

  beforeAll(async () => {
    // 假的 GitHub：网页 /releases/latest 跳转到 /releases/tag/<tag>（读版本号）；API 只用来取更新说明
    server = http.createServer((req, res) => {
      hits++;
      if (req.url === "/acme/app/releases/latest") {
        if (release.status === 404) return (res.writeHead(404), res.end());
        if (release.status === 403) return (res.writeHead(429), res.end());
        const tag = release.body.tag_name;
        res.writeHead(302, { location: tag ? `/acme/app/releases/tag/${tag}` : "/acme/app/releases" });
        return res.end();
      }
      if (req.url?.startsWith("/repos/acme/app/releases/tags/")) {
        res.writeHead(release.apiStatus ?? 200, { "content-type": "application/json" });
        return res.end(JSON.stringify(release.body));
      }
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => void server.close());

  function make(over: Partial<ConstructorParameters<typeof Updater>[0]> = {}) {
    const sent: UpdateStateDTO[] = [];
    const opened: string[] = [];
    const u = new Updater({ version: "0.1.0", repo: () => "acme/app", send: s => sent.push(s), openExternal: x => opened.push(x), canAutoInstall: false, apiBase: base, webBase: base, ...over });
    return { u, sent, opened };
  }

  it("没配仓库：手动检查提示未配置，自动检查不打扰", async () => {
    const { u } = make({ repo: () => "", defaultRepo: "" });
    expect((await u.check({ silent: true })).state).toBe("idle");
    expect((await u.check()).state).toBe("unconfigured");
  });

  it("有新版本 → available；已是最新 → none", async () => {
    release = { status: 200, body: { tag_name: "v0.2.0", body: "## 新功能\n- a", html_url: "https://github.com/acme/app/releases/tag/v0.2.0" } };
    const { u, sent } = make();
    const s = await u.check();
    expect(s).toMatchObject({ state: "available", latest: "0.2.0", current: "0.1.0", repo: "acme/app" });
    expect(s.notes).toContain("新功能");
    expect(sent.map(x => x.state)).toEqual(["checking", "available"]);

    release = { status: 200, body: { tag_name: "v0.1.0", html_url: "x" } };
    expect((await make().u.check()).state).toBe("none");
  });

  it("404 / 限流报错；自动检查失败时保持原状态", async () => {
    release = { status: 404, body: {} };
    const { u } = make();
    const s = await u.check();
    expect(s.state).toBe("error");
    expect(s.error).toContain("Release");

    release = { status: 200, body: { tag_name: "v0.3.0", html_url: "https://github.com/acme/app/releases" } };
    await u.check();
    expect(u.state.state).toBe("available");
    release = { status: 403, body: {} };
    expect((await u.check({ silent: true })).state).toBe("available");
  });

  it("API 被限流（403）也不影响检查：照样报「有新版本」，只是没有更新说明", async () => {
    release = { status: 200, body: { tag_name: "v0.2.0", body: "不会用到" }, apiStatus: 403 };
    const { u } = make();
    const s = await u.check();
    expect(s).toMatchObject({ state: "available", latest: "0.2.0", url: "https://github.com/acme/app/releases/tag/v0.2.0" });
    expect(s.notes).toBe("");
  });

  it("仓库还没发布过 Release：给出明确提示", async () => {
    release = { status: 200, body: {} };
    const s = await make().u.check();
    expect(s.state).toBe("error");
    expect(s.error).toContain("还没有发布过 Release");
  });

  it("并发检查合并为一次请求", async () => {
    release = { status: 200, body: { tag_name: "v0.1.0", html_url: "x" } };
    const { u } = make();
    hits = 0;
    await Promise.all([u.check(), u.check(), u.check()]);
    expect(hits).toBe(1);
  });

  it("不能应用内安装：download 打开 Release 页面", async () => {
    release = { status: 200, body: { tag_name: "v0.2.0", html_url: "https://github.com/acme/app/releases/tag/v0.2.0" } };
    const { u, opened } = make();
    await u.check();
    await u.download();
    expect(opened).toEqual(["https://github.com/acme/app/releases/tag/v0.2.0"]);
  });

  it("应用内安装：下载进度 → downloaded → install", async () => {
    release = { status: 200, body: { tag_name: "v0.2.0", html_url: "https://github.com/acme/app/releases/tag/v0.2.0" } };
    const handlers: Record<string, (...a: any[]) => void> = {};
    let feed: any;
    let installed = false;
    const au: AutoUpdaterLike = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      setFeedURL: o => (feed = o),
      checkForUpdates: async () => ({}),
      downloadUpdate: async () => {
        handlers["download-progress"]?.({ percent: 42.4 });
        handlers["update-downloaded"]?.({});
      },
      quitAndInstall: () => (installed = true),
      on: (e, cb) => void (handlers[e] = cb),
      removeAllListeners: () => undefined,
    };
    const { u, sent, opened } = make({ canAutoInstall: true, loadAutoUpdater: async () => au });
    await u.check();
    u.install(); // 还没下载完：不应触发
    expect(installed).toBe(false);
    const s = await u.download();
    expect(feed).toEqual({ provider: "github", owner: "acme", repo: "app" });
    expect(au.autoDownload).toBe(false);
    expect(s.state).toBe("downloaded");
    expect(sent.some(x => x.state === "downloading" && x.percent === 42)).toBe(true);
    expect(opened).toEqual([]);
    u.install();
    expect(installed).toBe(true);
  });

  it("自动更新：发现新版本自动下载并安装，任务在跑时等空闲再装，不弹页面", async () => {
    release = { status: 200, body: { tag_name: "v0.2.0", html_url: "https://github.com/acme/app/releases/tag/v0.2.0" } };
    const handlers: Record<string, (...a: any[]) => void> = {};
    let installed: unknown[] | undefined;
    const au: AutoUpdaterLike = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      setFeedURL() {},
      checkForUpdates: async () => ({}),
      downloadUpdate: async () => void handlers["update-downloaded"]?.({}),
      quitAndInstall: (...a) => (installed = a),
      on: (e, cb) => void (handlers[e] = cb),
      removeAllListeners: () => undefined,
    };
    let busy = true;
    const { u, opened } = make({ canAutoInstall: true, autoApply: true, busy: () => busy, retryMs: 20, loadAutoUpdater: async () => au });
    await u.check();
    await new Promise(r => setTimeout(r, 80));
    expect(u.state.state).toBe("downloaded");
    expect(installed).toBeUndefined(); // 还有任务在跑
    busy = false;
    await new Promise(r => setTimeout(r, 80));
    expect(installed).toEqual([true, true]);
    expect(opened).toEqual([]);
  });

  it("自动更新下载失败：不打开网页，不打扰", async () => {
    release = { status: 200, body: { tag_name: "v0.2.0", html_url: "https://github.com/acme/app/releases/tag/v0.2.0" } };
    const au = { autoDownload: true, autoInstallOnAppQuit: true, setFeedURL() {}, checkForUpdates: async () => Promise.reject(new Error("latest.yml 404")), downloadUpdate: async () => ({}), quitAndInstall() {}, on() {} } as AutoUpdaterLike;
    const { u, opened } = make({ canAutoInstall: true, autoApply: true, loadAutoUpdater: async () => au });
    await u.check();
    await new Promise(r => setTimeout(r, 50));
    expect(u.state.state).toBe("error");
    expect(opened).toEqual([]);
  });

  it("应用内下载失败：报错并打开下载页兜底", async () => {
    release = { status: 200, body: { tag_name: "v0.2.0", html_url: "https://github.com/acme/app/releases/tag/v0.2.0" } };
    const au = { autoDownload: true, autoInstallOnAppQuit: true, setFeedURL() {}, checkForUpdates: async () => Promise.reject(new Error("latest.yml 404")), downloadUpdate: async () => ({}), quitAndInstall() {}, on() {} } as AutoUpdaterLike;
    const { u, opened } = make({ canAutoInstall: true, loadAutoUpdater: async () => au });
    await u.check();
    const s = await u.download();
    expect(s.state).toBe("error");
    expect(s.error).toContain("latest.yml");
    expect(opened).toHaveLength(1);
  });
});

describe("Backend.providerModels 缓存", () => {
  let server: http.Server;
  let url = "";
  let calls: string[] = [];
  let home = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      calls.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m-b" }, { id: "m-a" }] }));
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as any).port}`;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-models-"));
    fs.writeFileSync(
      path.join(home, "harness.config.json"),
      JSON.stringify({ defaultProvider: "x", providers: { x: { type: "openai-compat", baseURL: url, apiKey: "k1", model: "m-a" } } }),
    );
  });
  afterAll(() => void server.close());

  it("只请求 /models（不查账号）、并发合并、命中缓存不联网、refresh 才联网、重启后读磁盘缓存", async () => {
    const b = new Backend(home, { send() {} });
    const [r1, r2] = await Promise.all([b.providerModels("x"), b.providerModels("x")]);
    expect(r1.models).toEqual(["m-a", "m-b"]);
    expect(r2.ok).toBe(true);
    expect(calls).toEqual(["/models"]);

    const hit = await b.providerModels("x");
    expect(hit.cached).toBe(true);
    expect(calls).toHaveLength(1);

    await b.providerModels("x", { refresh: true });
    expect(calls).toHaveLength(2);

    const b2 = new Backend(home, { send() {} });
    const disk = await b2.providerModels("x", { cacheOnly: true });
    expect(disk).toMatchObject({ ok: true, cached: true, models: ["m-a", "m-b"] });
    expect(calls).toHaveLength(2);

    // Key 变了 → 缓存失效
    fs.writeFileSync(
      path.join(home, "harness.config.json"),
      JSON.stringify({ providers: { x: { type: "openai-compat", baseURL: url, apiKey: "k2", model: "m-a" } } }),
    );
    const b3 = new Backend(home, { send() {} });
    expect((await b3.providerModels("x", { cacheOnly: true })).ok).toBe(false);
  });
});
