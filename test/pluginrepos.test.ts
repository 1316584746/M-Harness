import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeZip } from "../scripts/zip.mjs";
import { DbxBridge } from "../desktop/main/dbx";
import { installDbxpBuffer, installDbxpFromUrl } from "../desktop/main/dbxp";
import { PluginRepos } from "../desktop/main/pluginrepos";
import { DBX_CATALOG_URL, DBX_SOURCE, OFFICIAL_REPO_NAME, OFFICIAL_REPO_URL } from "../desktop/shared/plugins";

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const tmps: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "prepos-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function pack(id = "x.y", version = "1.0.0", opts: { sums?: boolean; tamper?: boolean } = {}) {
  const files = [
    { name: "manifest.json", data: JSON.stringify({ id, name: `插件 ${id}`, version }) },
    { name: "ui/index.html", data: "<html></html>" },
  ];
  if (opts.sums !== false) files.push({ name: "checksums.json", data: JSON.stringify({ algorithm: "sha256", files: Object.fromEntries(files.map(f => [f.name, opts.tamper ? "0".repeat(64) : sha(f.data)])) }) });
  return makeZip(files);
}

describe("插件仓库列表", () => {
  it("起步预置一个常用仓库，之后和别的仓库没区别：添加 / 停用 / 删除；存在文件里", () => {
    const f = path.join(tmp(), "repos.json");
    const r = new PluginRepos(f);
    expect(r.list().map(x => x.id)).toEqual(["m-market", "dbx"]); // 官方仓库排最前，DBX 是预置的第三方
    expect(r.list()[0]).toMatchObject({ enabled: true, name: OFFICIAL_REPO_NAME, url: OFFICIAL_REPO_URL });
    expect(r.list()[1]).toMatchObject({ enabled: true, name: DBX_SOURCE });
    expect(r.list()[0]).not.toHaveProperty("rev");
    r.add({ id: "Acme", name: "Acme 仓库", url: "https://plugins.acme.com/catalog/index.json" });
    expect(r.list().map(x => x.id)).toEqual(["m-market", "dbx", "acme"]);
    expect(new PluginRepos(f).extra()).toHaveLength(3); // 重新读文件还在
    r.setEnabled("acme", false);
    expect(r.extra()).toHaveLength(2);
    expect(r.list()[2].enabled).toBe(false);
    r.setEnabled("acme", true);
    expect(r.remove("acme")).toBe(true);
    expect(r.remove("acme")).toBe(false);
    expect(r.list()).toHaveLength(2);
  });

  it("GitHub 仓库：链接和 owner/repo 简写都能加，id 取仓库名", () => {
    const r = new PluginRepos(path.join(tmp(), "repos.json"));
    const a = r.add({ url: "me/cool-skills" });
    expect(a).toMatchObject({ id: "cool-skills", url: "https://github.com/me/cool-skills" });
    const b = r.add({ url: "https://github.com/someone/other/tree/main/plugins" });
    expect(b.id).toBe("other");
    expect(b.url).toContain("github.com/someone/other/tree/main/plugins");
  });

  it("预置的仓库也能停用、删除；删了不会再回来，重启后状态还在", () => {
    const f = path.join(tmp(), "repos.json");
    const r = new PluginRepos(f);
    r.add({ id: "acme", url: "https://plugins.acme.com/i.json" });
    r.setEnabled("dbx", false);
    r.setEnabled("m-market", false);
    expect(r.list()[1]).toMatchObject({ id: "dbx", enabled: false });
    expect(new PluginRepos(f).list()[1].enabled).toBe(false); // 重新读文件还是停用
    expect(new PluginRepos(f).extra().map(x => x.id)).toEqual(["acme"]);
    r.setEnabled("dbx", true);
    r.setEnabled("m-market", true);
    expect(r.list()[1].enabled).toBe(true);
    expect(r.remove("dbx")).toBe(true);
    expect(r.remove("m-market")).toBe(true);
    expect(new PluginRepos(f).list().map(x => x.id)).toEqual(["acme"]); // 官方和 DBX 删了都不会再被塞回来
    // 删光了就是空的
    r.remove("acme");
    expect(new PluginRepos(f).list()).toEqual([]);
    // 删掉后可以再手动加回来（界面上的「常用仓库」就是这么做的）
    expect(r.add({ id: "dbx", name: DBX_SOURCE, url: DBX_CATALOG_URL }).id).toBe("dbx");
  });

  it("旧版本的文件（官方仓库是固定的）：补成普通一行，保留它的停用状态和第三方仓库", () => {
    const f = path.join(tmp(), "repos.json");
    fs.writeFileSync(f, JSON.stringify({ repos: [{ id: "acme", name: "Acme", url: "https://plugins.acme.com/i.json", enabled: true }], officialEnabled: false }));
    const r = new PluginRepos(f);
    expect(r.list().map(x => `${x.id}:${x.enabled}`)).toEqual(["m-market:true", "dbx:false", "acme:true"]);
    r.remove("acme");
    expect(new PluginRepos(f).list().map(x => x.id)).toEqual(["m-market", "dbx"]);
  });

  it("老用户（已经预置过 DBX）升级后补上官方仓库，只补一次；停用的 DBX 保持停用", () => {
    const f = path.join(tmp(), "repos.json");
    fs.writeFileSync(f, JSON.stringify({ seeded: true, repos: [{ id: "dbx", name: DBX_SOURCE, url: DBX_CATALOG_URL, enabled: false }, { id: "acme", name: "Acme", url: "https://plugins.acme.com/i.json", enabled: true }] }));
    const r = new PluginRepos(f);
    expect(r.list().map(x => `${x.id}:${x.enabled}`)).toEqual(["m-market:true", "dbx:false", "acme:true"]);
    r.setEnabled("m-market", false); // 一保存就记下已经补过
    expect(new PluginRepos(f).list().map(x => `${x.id}:${x.enabled}`)).toEqual(["m-market:false", "dbx:false", "acme:true"]);
    expect(r.remove("m-market")).toBe(true);
    expect(new PluginRepos(f).list().map(x => x.id)).toEqual(["dbx", "acme"]); // 删了不再回来
  });

  it("用户自己已经加过官方仓库的地址：不重复补", () => {
    const f = path.join(tmp(), "repos.json");
    fs.writeFileSync(f, JSON.stringify({ seeded: true, repos: [{ id: "mine", name: "我加的", url: OFFICIAL_REPO_URL, enabled: true }] }));
    expect(new PluginRepos(f).list().map(x => x.id)).toEqual(["mine"]);
  });

  it("ID、地址、名称重复或不合法都拒绝", () => {
    const r = new PluginRepos(path.join(tmp(), "repos.json"));
    expect(() => r.add({ id: "dbx", url: "https://a.com/i.json" })).toThrow(/已经存在/);
    expect(() => r.add({ id: "bad id!", url: "https://a.com/i.json" })).toThrow(/仓库 ID/);
    expect(r.add({ name: "dsh Market", url: "https://x.com/i.json" }).id).toBe("dsh-market");
    expect(r.add({ name: "中文仓库", url: "https://www.zh.example.com/i.json" }).id).toBe("zh-example-com");
    expect(r.add({ name: "dsh  Market!", url: "https://y.com/i.json" }).id).toBe("dsh-market-2");
    expect(() => r.add({ id: "a", url: "ftp://a.com/i.json" })).toThrow(/https/);
    expect(() => r.add({ id: "a", url: "http://evil.com/i.json" })).toThrow(/https/);
    expect(() => r.add({ id: "a", url: "https://u:p@a.com/i.json" })).toThrow(/账号密码/);
    expect(() => r.add({ id: "a", url: "不是地址" })).toThrow(/不合法/);
    r.add({ id: "a", name: "甲", url: "https://a.com/i.json" });
    expect(() => r.add({ id: "b", name: "乙", url: "https://a.com/i.json" })).toThrow(/添加过/);
    expect(() => r.add({ id: "b", name: "甲", url: "https://b.com/i.json" })).toThrow(/名称/);
    expect(() => r.add({ id: "b", name: DBX_SOURCE, url: "https://b.com/i.json" })).toThrow(/名称/);
    expect(() => r.setEnabled("zzz", true)).toThrow(/没有/);
  });

  it("最多 20 个；文件损坏当作第一次使用", () => {
    const f = path.join(tmp(), "repos.json");
    const r = new PluginRepos(f);
    for (let i = 0; i < 18; i++) r.add({ id: `r${i}`, url: `https://r${i}.com/i.json` });
    expect(() => r.add({ id: "r18", url: "https://r18.com/i.json" })).toThrow(/最多/);
    fs.writeFileSync(f, "{坏的");
    expect(r.list().map(x => x.id)).toEqual(["m-market", "dbx"]);
  });
});

describe("本地包 / 链接安装", () => {
  it("没有目录对照也能装：以包里的清单为准，必须带包内校验", () => {
    const root = tmp();
    expect(installDbxpBuffer(pack("x.y", "2.1.0"), root, { requireChecksums: true })).toEqual({ id: "x.y", version: "2.1.0", name: "插件 x.y" });
    expect(fs.existsSync(path.join(root, "x.y", "versions", "2.1.0", "manifest.json"))).toBe(true);
    expect(() => installDbxpBuffer(pack("n.o", "1.0.0", { sums: false }), root, { requireChecksums: true })).toThrow(/checksums/);
    expect(fs.existsSync(path.join(root, "n.o"))).toBe(false);
    expect(() => installDbxpBuffer(pack("t.t", "1.0.0", { tamper: true }), root, { requireChecksums: true })).toThrow(/校验失败/);
    expect(() => installDbxpBuffer(pack("../evil", "1.0.0"), root, { requireChecksums: true })).toThrow(/不合法/);
    expect(() => installDbxpBuffer(pack("ok.id", "1/../x"), root, { requireChecksums: true })).toThrow(/版本号/);
    expect(() => installDbxpBuffer(Buffer.from("不是 zip 不是 zip 不是 zip"), root, {})).toThrow();
  });

  it("链接：只收 https（本机地址除外），要以 .dbxp 结尾", async () => {
    const root = tmp();
    const buf = pack("u.v", "1.0.0");
    const ok = (async () => new Response(new Uint8Array(buf))) as unknown as typeof fetch;
    expect((await installDbxpFromUrl("https://example.com/p/u.v.dbxp", root, { fetchImpl: ok })).id).toBe("u.v");
    expect((await installDbxpFromUrl("http://127.0.0.1:9/u.v.dbxp", root, { fetchImpl: ok })).id).toBe("u.v");
    await expect(installDbxpFromUrl("http://example.com/u.dbxp", root, { fetchImpl: ok })).rejects.toThrow(/https/);
    await expect(installDbxpFromUrl("https://example.com/u.zip", root, { fetchImpl: ok })).rejects.toThrow(/dbxp/);
    await expect(installDbxpFromUrl("乱写", root, { fetchImpl: ok })).rejects.toThrow(/不合法/);
    const bad = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(installDbxpFromUrl("https://example.com/u.dbxp", root, { fetchImpl: bad })).rejects.toThrow(/404/);
  });
});

describe("多仓库目录", () => {
  const entry = (id: string, buf: Buffer, url: string) => ({ id, name: `P ${id}`, description: "d", latestVersion: "1.0.0", versions: [{ version: "1.0.0", artifacts: [{ target: "universal", url, sha256: sha(buf), size: buf.length }] }] });

  it("合并所有已启用的仓库；同一个 DBX 插件 id 排在前面的优先；某个仓库失败不影响别的；别的仓库的插件能装", async () => {
    const root = tmp();
    const official = pack("o.p", "1.0.0");
    const thirdOwn = pack("t.p", "1.0.0");
    const thirdShadow = pack("o.p", "1.0.0");
    const cats: Record<string, unknown> = {
      "http://127.0.0.1:9/official.json": { plugins: [entry("o.p", official, "http://127.0.0.1:9/o.dbxp")] },
      "https://third.example/catalog.json": { plugins: [entry("t.p", thirdOwn, "https://cdn.third.example/t.dbxp"), entry("o.p", thirdShadow, "https://cdn.third.example/shadow.dbxp")] },
    };
    const files: Record<string, Buffer> = { "http://127.0.0.1:9/o.dbxp": official, "https://cdn.third.example/t.dbxp": thirdOwn };
    const fetchImpl = (async (u: any) => {
      const k = String(u);
      if (k.includes("broken.example")) return new Response("x", { status: 500 });
      if (cats[k]) return new Response(JSON.stringify(cats[k]));
      return files[k] ? new Response(new Uint8Array(files[k])) : new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const dbxRepo = { id: "dbx", name: DBX_SOURCE, url: "http://127.0.0.1:9/official.json", enabled: true };
    let repos = [
      dbxRepo,
      { id: "third", name: "第三方", url: "https://third.example/catalog.json", enabled: true },
      { id: "broken", name: "坏仓库", url: "https://broken.example/i.json", enabled: true },
    ];
    const b = new DbxBridge(fetchImpl, { catalogUrl: "http://127.0.0.1:9/official.json", repos: () => repos, localDir: path.join(root, "plugins"), dataDir: path.join(root, "no"), platform: "win32", arch: "x64" });
    const rep = await b.catalogReport();
    expect(rep.entries.map(e => `${e.source}:${e.id}`).sort()).toEqual([`${DBX_SOURCE}:o.p`, "第三方:t.p"]);
    expect(rep.entries.find(e => e.id === "o.p")!.source).toBe(DBX_SOURCE); // 排在前面的优先，没被后面的顶替
    expect(rep.errors).toHaveLength(1);
    expect(rep.errors[0]).toMatchObject({ source: "坏仓库" });
    expect(rep.errors[0].error).toContain("500");
    expect(await b.install("t.p")).toBe("1.0.0"); // 第三方仓库指定的下载站，sha256 照样核对
    expect(b.info().local["t.p"]).toBeTruthy();
    // 只剩 DBX 仓库：别的仓库的插件不再出现
    repos = [dbxRepo];
    expect((await b.catalogReport(true)).entries.map(e => e.id)).toEqual(["o.p"]);
    // DBX 仓库和别的一样可以不要：没有它，商店里就没有它的插件，也不会因此报错
    repos = [{ id: "third", name: "第三方", url: "https://third.example/catalog.json", enabled: true }];
    const off = await b.catalogReport(true);
    expect(off.entries.map(e => `${e.source}:${e.id}`)).toEqual(["第三方:t.p", "第三方:o.p"]);
    expect(off.errors).toEqual([]);
    // 一个仓库都没有：空商店
    repos = [];
    expect(await b.catalogReport(true)).toEqual({ entries: [], errors: [] });
  });

  it("插件仓库收 DBX 目录和 DSH 索引：技能 / MCP / 规则格式的仓库说明「不是插件」", async () => {
    const root = tmp();
    const dbxPkg = pack("same.id", "1.0.0");
    const nativeSrc = {
      name: "我的插件源",
      plugins: [
        { id: "same.id", name: "同 id 的 MCP", kind: "mcp", description: "d", install: { server: { command: "npx", args: ["-y", "x"] } } },
        { id: "r1", name: "代码规范", kind: "rule", description: "d", install: { content: "写测试" } },
        { id: "bad", name: "坏条目", kind: "mcp", description: "d", install: {} },
      ],
    };
    const cats: Record<string, unknown> = {
      "http://127.0.0.1:9/official.json": { plugins: [] },
      "https://dbx.example/c.json": { plugins: [entry("same.id", dbxPkg, "https://dbx.example/p.dbxp")] },
      "https://native.example/m.json": nativeSrc,
      "https://dsh.example/i.json": { format: 1, plugins: [{ name: "dsh-x", versions: [{ version: "1", source: { type: "npm" } }] }] },
    };
    const fetchImpl = (async (u: any) => {
      const k = String(u);
      if (k === "https://dbx.example/p.dbxp") return new Response(new Uint8Array(dbxPkg));
      return cats[k] ? new Response(JSON.stringify(cats[k])) : new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const repos = [
      { id: "d", name: "DBX 仓库", url: "https://dbx.example/c.json", enabled: true },
      { id: "n", name: "原生仓库", url: "https://native.example/m.json", enabled: true },
      { id: "s", name: "DSH 市场", url: "https://dsh.example/i.json", enabled: true },
    ];
    const b = new DbxBridge(fetchImpl, { catalogUrl: "http://127.0.0.1:9/official.json", repos: () => repos, localDir: path.join(root, "p"), dataDir: path.join(root, "no"), platform: "win32", arch: "x64" });
    const rep = await b.catalogReport();
    expect(rep.entries.map(e => `${e.source}:${e.id}:${e.kind}`)).toEqual(["DBX 仓库:same.id:dbx", "DSH 市场:dsh:dsh-x:dsh"]);
    expect(rep.errors.find(e => e.source === "原生仓库")?.error).toContain("不是插件");
    expect(rep.errors.find(e => e.source === "DSH 市场")).toBeUndefined();
    expect(await b.install("same.id")).toBe("1.0.0");
  });

  it("测试仓库地址：成功给出插件数，失败给原因；测试不进缓存、不影响商店", async () => {
    const root = tmp();
    const buf = pack("t.p", "1.0.0");
    let hits = 0;
    const fetchImpl = (async (u: any) => {
      const k = String(u);
      hits++;
      if (k.includes("broken")) return new Response("x", { status: 500 });
      if (k.includes("native")) return new Response(JSON.stringify({ plugins: [{ id: "r", name: "r", kind: "rule", description: "d", install: { content: "x" } }] }));
      return new Response(JSON.stringify({ plugins: [entry("t.p", buf, "https://cdn.third.example/t.dbxp")] }));
    }) as unknown as typeof fetch;
    const b = new DbxBridge(fetchImpl, { catalogUrl: "http://127.0.0.1:9/official.json", repos: () => [], localDir: path.join(root, "p"), dataDir: path.join(root, "no"), platform: "win32", arch: "x64" });
    const ok = await b.testRepo({ id: "t", name: "t", url: "https://third.example/catalog.json", enabled: true });
    expect(ok.entries.map(e => e.id)).toEqual(["t.p"]);
    await b.testRepo({ id: "t", name: "t", url: "https://third.example/catalog.json", enabled: true });
    expect(hits).toBe(2); // 每次都是现读
    await expect(b.testRepo({ id: "t", name: "t", url: "https://broken.example/i.json", enabled: true })).rejects.toThrow(/500/);
    await expect(b.testRepo({ id: "t", name: "t", url: "https://native.example/m.json", enabled: true })).rejects.toThrow(/不是插件/);
  });

  it("第三方插件的包被换掉（sha256 对不上）会拒绝", async () => {
    const root = tmp();
    const good = pack("t.p", "1.0.0");
    const evil = pack("t.p", "1.0.0", { tamper: false });
    const fetchImpl = (async (u: any) => {
      const k = String(u);
      if (k.endsWith("official.json")) return new Response(JSON.stringify({ plugins: [] }));
      if (k.endsWith("catalog.json")) return new Response(JSON.stringify({ plugins: [entry("t.p", good, "https://cdn.third.example/t.dbxp")] }));
      return new Response(new Uint8Array(Buffer.concat([evil, Buffer.from("x")])));
    }) as unknown as typeof fetch;
    const b = new DbxBridge(fetchImpl, { catalogUrl: "http://127.0.0.1:9/official.json", repos: () => [{ id: "third", name: "第三方", url: "https://third.example/catalog.json", enabled: true }], localDir: path.join(root, "p"), dataDir: path.join(root, "no"), platform: "win32", arch: "x64" });
    await expect(b.install("t.p")).rejects.toThrow(/大小不对|校验失败/);
    expect(fs.existsSync(path.join(root, "p", "t.p"))).toBe(false);
  });
});
