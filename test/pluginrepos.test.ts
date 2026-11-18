import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeZip } from "../scripts/zip.mjs";
import { DbxBridge } from "../desktop/main/dbx";
import { installDbxpBuffer, installDbxpFromUrl } from "../desktop/main/dbxp";
import { PluginRepos } from "../desktop/main/pluginrepos";
import { DBX_SOURCE } from "../desktop/shared/plugins";

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
  it("官方在最前面；添加 / 停用 / 删除；存在文件里", () => {
    const f = path.join(tmp(), "repos.json");
    const r = new PluginRepos(f);
    expect(r.list().map(x => x.id)).toEqual(["dbx"]);
    expect(r.list()[0]).toMatchObject({ official: true, enabled: true, name: DBX_SOURCE });
    r.add({ id: "Acme", name: "Acme 仓库", url: "https://plugins.acme.com/catalog/index.json" });
    expect(r.list().map(x => x.id)).toEqual(["dbx", "acme"]);
    expect(new PluginRepos(f).extra()).toHaveLength(1); // 重新读文件还在
    r.setEnabled("acme", false);
    expect(r.extra()).toHaveLength(0);
    expect(r.list()[1].enabled).toBe(false);
    r.setEnabled("acme", true);
    expect(r.remove("acme")).toBe(true);
    expect(r.remove("acme")).toBe(false);
    expect(r.list()).toHaveLength(1);
  });

  it("官方不能删 / 停；ID、地址、名称重复或不合法都拒绝", () => {
    const r = new PluginRepos(path.join(tmp(), "repos.json"));
    expect(() => r.remove("dbx")).toThrow(/官方/);
    expect(() => r.setEnabled("dbx", false)).toThrow(/官方/);
    expect(() => r.add({ id: "dbx", url: "https://a.com/i.json" })).toThrow(/已经存在/);
    expect(() => r.add({ id: "bad id!", url: "https://a.com/i.json" })).toThrow(/仓库 ID/);
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

  it("最多 10 个；文件损坏当作没有", () => {
    const f = path.join(tmp(), "repos.json");
    const r = new PluginRepos(f);
    for (let i = 0; i < 10; i++) r.add({ id: `r${i}`, url: `https://r${i}.com/i.json` });
    expect(() => r.add({ id: "r10", url: "https://r10.com/i.json" })).toThrow(/最多/);
    fs.writeFileSync(f, "{坏的");
    expect(r.extra()).toEqual([]);
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

  it("合并官方和第三方；同一个 id 官方优先；某个仓库失败不影响别的；第三方插件能装", async () => {
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
    let repos = [
      { id: "third", name: "第三方", url: "https://third.example/catalog.json", enabled: true },
      { id: "broken", name: "坏仓库", url: "https://broken.example/i.json", enabled: true },
    ];
    const b = new DbxBridge(fetchImpl, { catalogUrl: "http://127.0.0.1:9/official.json", extraRepos: () => repos, localDir: path.join(root, "plugins"), dataDir: path.join(root, "no"), platform: "win32", arch: "x64" });
    const rep = await b.catalogReport();
    expect(rep.entries.map(e => `${e.source}:${e.id}`).sort()).toEqual([`${DBX_SOURCE}:o.p`, "第三方:t.p"]);
    expect(rep.entries.find(e => e.id === "o.p")!.source).toBe(DBX_SOURCE); // 官方优先，没被第三方顶替
    expect(rep.errors).toHaveLength(1);
    expect(rep.errors[0]).toMatchObject({ source: "坏仓库" });
    expect(rep.errors[0].error).toContain("500");
    expect(await b.install("t.p")).toBe("1.0.0"); // 第三方仓库指定的下载站，sha256 照样核对
    expect(b.info().local["t.p"]).toBeTruthy();
    // 停用后，目录里不再有它
    repos = [];
    expect((await b.catalogReport(true)).entries.map(e => e.id)).toEqual(["o.p"]);
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
    const b = new DbxBridge(fetchImpl, { catalogUrl: "http://127.0.0.1:9/official.json", extraRepos: () => [{ id: "third", name: "第三方", url: "https://third.example/catalog.json", enabled: true }], localDir: path.join(root, "p"), dataDir: path.join(root, "no"), platform: "win32", arch: "x64" });
    await expect(b.install("t.p")).rejects.toThrow(/大小不对|校验失败/);
    expect(fs.existsSync(path.join(root, "p", "t.p"))).toBe(false);
  });
});
