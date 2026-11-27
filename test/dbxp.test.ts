import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeZip } from "../scripts/zip.mjs";
import { DbxBridge, scanDbxPlugins } from "../desktop/main/dbx";
import { installDbxp, readLocalInfo, readZip, uninstallDbxp, uninstallDbxpAsync } from "../desktop/main/dbxp";
import { parseDbxCatalog } from "../desktop/shared/plugins";

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const tmps: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dbxp-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const manifest = (over: object = {}) =>
  JSON.stringify({
    id: "a.b",
    name: "Alpha",
    version: "1.0.0",
    permissions: ["host.ai"],
    entrypoints: { ui: { entry: "ui/index.html" }, backend: { executable: "bin/x" } },
    contributions: [{ type: "workbench", id: "w" }, { type: "mcp", id: "m", tools: { a: {}, b: {} } }],
    ...over,
  });

function pack(opts: { manifest?: string; files?: Array<{ name: string; data: string }>; sums?: Record<string, string> | false } = {}) {
  const files = [{ name: "manifest.json", data: opts.manifest ?? manifest() }, { name: "ui/index.html", data: "<html></html>" }, { name: "bin/x", data: "exe" }, ...(opts.files ?? [])];
  if (opts.sums !== false) {
    const sums = opts.sums ?? Object.fromEntries(files.map(f => [f.name, sha(f.data)]));
    files.push({ name: "checksums.json", data: JSON.stringify({ algorithm: "sha256", files: sums }) });
  }
  return makeZip(files);
}

const serve = (buf: Buffer, status = 200): typeof fetch => (async () => new Response(status === 200 ? new Uint8Array(buf) : "no", { status })) as unknown as typeof fetch;
const spec = (buf: Buffer, over: object = {}) => ({ id: "a.b", version: "1.0.0", url: "https://dl.dbxio.com/plugins/a.b/1.0.0/a.b-1.0.0-universal.dbxp", sha256: sha(buf), size: buf.length, ...over });

describe("readZip", () => {
  it("读出文件，目录项忽略", () => {
    const z = readZip(makeZip([{ name: "a.txt", data: "hello" }, { name: "d/b.txt", data: "x".repeat(5000) }]));
    expect(z.map(f => f.name)).toEqual(["a.txt", "d/b.txt"]);
    expect(z[1].data.length).toBe(5000);
  });
  it("不是 zip / 路径不安全都报错", () => {
    expect(() => readZip(Buffer.from("nope nope nope nope nope nope"))).toThrow(/zip/);
    expect(() => readZip(makeZip([{ name: "../evil.txt", data: "x" }]))).toThrow(/不安全/);
    expect(() => readZip(makeZip([{ name: "/abs.txt", data: "x" }]))).toThrow(/不安全/);
    expect(() => readZip(makeZip([{ name: "C:/x.txt", data: "x" }]))).toThrow(/不安全/);
  });
});

describe("installDbxp", () => {
  it("下载、校验、解压到 plugins/<id>/versions/<版本>/，扫描能认出来", async () => {
    const root = tmp();
    const buf = pack();
    expect(await installDbxp(spec(buf), root, { fetchImpl: serve(buf) })).toBe("1.0.0");
    expect(fs.readFileSync(path.join(root, "a.b", "versions", "1.0.0", "ui", "index.html"), "utf8")).toBe("<html></html>");
    expect(scanDbxPlugins(path.dirname(root), path.basename(root))).toEqual({ "a.b": "1.0.0" });
    expect(readLocalInfo(root, "a.b", "1.0.0")).toMatchObject({ name: "Alpha", ui: true, backend: true, tools: 2, permissions: ["host.ai"], kinds: ["workbench", "mcp"] });
  });

  it("更新：只留最新版本，临时目录不留", async () => {
    const root = tmp();
    const v1 = pack();
    await installDbxp(spec(v1), root, { fetchImpl: serve(v1) });
    const v2 = pack({ manifest: manifest({ version: "1.1.0" }) });
    await installDbxp(spec(v2, { version: "1.1.0" }), root, { fetchImpl: serve(v2) });
    expect(fs.readdirSync(path.join(root, "a.b", "versions"))).toEqual(["1.1.0"]);
    expect(fs.readdirSync(path.join(root, "a.b")).filter(n => n.startsWith(".tmp"))).toEqual([]);
  });

  it("拒绝：sha256 不对、没有校验值、大小不对、非官方域名、HTTP 错误", async () => {
    const root = tmp();
    const buf = pack();
    await expect(installDbxp(spec(buf, { sha256: "0".repeat(64) }), root, { fetchImpl: serve(buf) })).rejects.toThrow(/校验失败/);
    await expect(installDbxp(spec(buf, { sha256: "" }), root, { fetchImpl: serve(buf) })).rejects.toThrow(/校验值/);
    await expect(installDbxp(spec(buf, { size: 1 }), root, { fetchImpl: serve(buf) })).rejects.toThrow(/大小/);
    await expect(installDbxp(spec(buf, { url: "https://evil.com/a.dbxp" }), root, { fetchImpl: serve(buf) })).rejects.toThrow(/下载站/);
    await expect(installDbxp(spec(buf, { url: "http://dl.dbxio.com/a.dbxp" }), root, { fetchImpl: serve(buf) })).rejects.toThrow(/下载站/);
    await expect(installDbxp(spec(buf, { url: "https://dl.dbxio.com/a.zip" }), root, { fetchImpl: serve(buf) })).rejects.toThrow(/下载站/);
    await expect(installDbxp(spec(buf), root, { fetchImpl: serve(buf, 404) })).rejects.toThrow(/404/);
    expect(fs.existsSync(path.join(root, "a.b"))).toBe(false); // 校验没过：什么都没写
  });

  it("拒绝：包里的 id / 版本和目录不一致、包内文件校验不过、不安全的 id", async () => {
    const root = tmp();
    const other = pack({ manifest: manifest({ id: "x.y" }) });
    await expect(installDbxp(spec(other), root, { fetchImpl: serve(other) })).rejects.toThrow(/不一致/);
    const ver = pack({ manifest: manifest({ version: "9.9.9" }) });
    await expect(installDbxp(spec(ver), root, { fetchImpl: serve(ver) })).rejects.toThrow(/不一致/);
    const bad = pack({ sums: { "bin/x": "0".repeat(64) } });
    await expect(installDbxp(spec(bad), root, { fetchImpl: serve(bad) })).rejects.toThrow(/校验失败/);
    const buf = pack();
    await expect(installDbxp(spec(buf, { id: "../up" }), root, { fetchImpl: serve(buf) })).rejects.toThrow(/不合法/);
    await expect(installDbxp(spec(buf, { id: "a/b" }), root, { fetchImpl: serve(buf) })).rejects.toThrow(/不合法/);
    const evil = makeZip([{ name: "manifest.json", data: manifest() }, { name: "../../evil.txt", data: "x" }]);
    await expect(installDbxp(spec(evil), root, { fetchImpl: serve(evil) })).rejects.toThrow(/不安全/);
    expect(fs.existsSync(path.join(root, "..", "evil.txt"))).toBe(false);
  });

  it("没有 checksums.json 的包也能装（校验仍然靠官方目录里的 sha256）", async () => {
    const root = tmp();
    const buf = pack({ sums: false });
    expect(await installDbxp(spec(buf), root, { fetchImpl: serve(buf) })).toBe("1.0.0");
  });

  it("卸载只删这个插件", async () => {
    const root = tmp();
    const buf = pack();
    await installDbxp(spec(buf), root, { fetchImpl: serve(buf) });
    expect(uninstallDbxp("a.b", root)).toBe(true);
    expect(uninstallDbxp("a.b", root)).toBe(false);
    expect(() => uninstallDbxp("../x", root)).toThrow();
    expect(fs.existsSync(root)).toBe(true);
  });

  it("异步卸载：删得掉、再删返回 false、不合法的 id 报错", async () => {
    const root = tmp();
    const buf = pack();
    await installDbxp(spec(buf), root, { fetchImpl: serve(buf) });
    expect(await uninstallDbxpAsync("a.b", root)).toBe(true);
    expect(fs.existsSync(path.join(root, "a.b"))).toBe(false);
    expect(await uninstallDbxpAsync("a.b", root)).toBe(false);
    await expect(uninstallDbxpAsync("../x", root)).rejects.toThrow();
  });
});

describe("目录里 universal 的包", () => {
  const cat = (arts: object[]) => ({ plugins: [{ id: "u.p", name: "U", description: "d", latestVersion: "1.0.0", versions: [{ version: "1.0.0", artifacts: arts }] }] });
  it("没有当前系统的包时用 universal，当前系统有就优先用它", () => {
    const uni = { target: "universal", url: "https://dl.dbxio.com/u.dbxp", sha256: "a".repeat(64) };
    const win = { target: "windows-x64", url: "https://dl.dbxio.com/w.dbxp", sha256: "b".repeat(64) };
    expect((parseDbxCatalog(cat([uni]), "windows-x64")[0].install as any).url).toContain("u.dbxp");
    expect((parseDbxCatalog(cat([uni, win]), "windows-x64")[0].install as any).url).toContain("w.dbxp");
    expect((parseDbxCatalog(cat([win]), "darwin-arm64")[0].install as any).url).toBeUndefined();
  });
});

describe("DbxBridge 直接安装", () => {
  it("装 / 看 / 卸，不需要 DBX（DBX 数据目录不存在）", async () => {
    const root = tmp();
    const buf = pack();
    const catalog = { plugins: [{ id: "a.b", name: "Alpha", description: "d", latestVersion: "1.0.0", versions: [{ version: "1.0.0", artifacts: [{ target: "universal", url: "http://127.0.0.1:9/p.dbxp", sha256: sha(buf), size: buf.length }] }] }] };
    const fetchImpl = (async (u: any) => (String(u).endsWith("index.json") ? new Response(JSON.stringify(catalog)) : new Response(new Uint8Array(buf)))) as unknown as typeof fetch;
    const b = new DbxBridge(fetchImpl, { catalogUrl: "http://127.0.0.1:9/index.json", repos: () => [{ id: "dbx", name: "DBX 插件中心", url: "http://127.0.0.1:9/index.json", enabled: true }], localDir: path.join(root, "plugins"), dataDir: path.join(root, "no-dbx"), platform: "win32", arch: "x64" });
    expect(b.info()).toMatchObject({ appFound: false, plugins: {}, local: {} });
    expect(await b.install("a.b")).toBe("1.0.0");
    expect(b.info().local["a.b"]).toMatchObject({ version: "1.0.0", name: "Alpha", tools: 2 });
    await expect(b.install("nope")).rejects.toThrow(/没有这个插件/);
    expect(b.uninstall("a.b")).toBe(true);
    expect(b.info().local).toEqual({});
  });
});
