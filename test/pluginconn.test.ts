import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionStore } from "../desktop/main/connections";
import { PluginHost } from "../desktop/main/pluginhost";
import { DEFAULTS, type ConnectionInput } from "../desktop/shared/connections";

// 假的 XXL-JOB 后台：和真插件一样，必须先 connection/connect，才能调 xxljob/*
const SIDECAR = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = o => process.stdout.write(JSON.stringify(o) + "\\n");
const sessions = new Map();
rl.on("line", l => {
  const m = JSON.parse(l);
  const ok = r => send({ jsonrpc: "2.0", id: m.id, result: r });
  const bad = s => send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: s } });
  if (m.method === "plugin/initialize") return ok({ protocolVersion: 1, plugin: { id: process.env.DBX_PLUGIN_ID }, capabilities: ["connections"] });
  if (m.method === "connection/connect") {
    const c = m.params.connection;
    if (!c || !(c.id || c.connectionId)) return bad("缺少连接 ID");
    sessions.set(c.id, c);
    return ok({ ok: true });
  }
  if (m.method === "connection/disconnect") { sessions.delete(m.params.connectionId); return ok(null); }
  if (m.method === "xxljob/info") {
    const s = sessions.get(m.params.connectionId);
    if (!s) return bad("连接尚未建立或已经断开，请重新连接");
    return ok({ conn: s, connects: [...sessions.keys()].length });
  }
  if (m.method === "drop") { sessions.clear(); return ok(true); }
  bad("no method");
});
`;

let tmp: string;
let store: ConnectionStore;
const hosts: PluginHost[] = [];

function install(dbType = "xxl-job-dbx-plugin") {
  const dir = path.join(tmp, "plugins", "io.t.xxl", "versions", "1.0.0");
  fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ui", "index.html"), "<html><head></head><body>x</body></html>");
  fs.writeFileSync(path.join(dir, "bin", "s.js"), SIDECAR);
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: "io.t.xxl",
      name: "XXL",
      version: "1.0.0",
      permissions: [],
      entrypoints: { backend: { executable: "bin/s.js" }, ui: { root: "ui", entry: "ui/index.html" } },
      contributions: [
        { type: "connection-provider", database_type: dbType, id: "io.t.xxl.connection", workbench: "io.t.xxl.workbench" },
        { type: "workbench", id: "io.t.xxl.workbench" },
      ],
    }),
  );
}

function mk(): PluginHost {
  const h = new PluginHost({
    localDir: path.join(tmp, "plugins"),
    dataRoot: path.join(tmp, "data"),
    consentFile: path.join(tmp, "consent.json"),
    launch: exe => ({ command: process.execPath, args: [exe] }),
    connections: {
      list: kind => store.list().filter(c => c.kind === kind),
      get: id => {
        const conn = store.get(id);
        return conn && { conn, secrets: store.secretsOf(id) };
      },
    },
  });
  hosts.push(h);
  return h;
}

const xxl = (name: string, o: Partial<ConnectionInput> = {}, fields: Record<string, string> = {}): ConnectionInput => ({
  kind: "xxljob",
  name,
  env: "生产",
  machine: "m1",
  fields: { ...DEFAULTS.xxljob, url: "https://job.example.com:8443/xxl-job-admin/", username: "admin", ...fields },
  secrets: { password: "pw-123" },
  ...o,
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugconn-"));
  store = new ConnectionStore(path.join(tmp, "home"));
});
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stopAll();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("连接类插件：用本软件的连接，不依赖 DBX", () => {
  it("连接类插件在列表里带着连接类型；可选的连接只含启用的同类连接，不含秘密", () => {
    install();
    const a = store.save(xxl("调度-生产"));
    store.save(xxl("调度-测试", { env: "测试", machine: "m2" }));
    const off = store.save(xxl("停用的"));
    store.setEnabled(off.id, false);
    store.save({ kind: "redis", name: "r", env: "测试", machine: "", fields: { ...DEFAULTS.redis, host: "h" } });
    const h = mk();
    h.trust("io.t.xxl");
    expect(h.list()[0].connKind).toBe("xxljob");
    const l = h.connectionsFor("io.t.xxl");
    expect(l.map(c => c.name).sort()).toEqual(["调度-测试", "调度-生产"]);
    expect(l.find(c => c.id === a.id)).toMatchObject({ env: "生产", machine: "m1" });
    expect(JSON.stringify(l)).not.toContain("pw-123");
  });

  it("没有适配器的插件不是连接类", () => {
    install("some-other-db");
    const h = mk();
    expect(h.list()[0].connKind).toBeUndefined();
    expect(h.connectionsFor("io.t.xxl")).toEqual([]);
  });

  it("界面带着 connectionId 调后台：自动先 connection/connect，把地址、账号、密码、环境翻译给插件", async () => {
    install();
    const c = store.save(xxl("调度-生产"));
    const h = mk();
    h.trust("io.t.xxl");
    const r = await h.request("io.t.xxl", "backend.invoke", { method: "xxljob/info", params: { connectionId: c.id } });
    expect(r.ok).toBe(true);
    const got = (r.result as { conn: Record<string, unknown> }).conn;
    expect(got).toMatchObject({ id: c.id, host: "job.example.com", port: 8443, username: "admin", password: "pw-123" });
    expect(got.config).toMatchObject({ scheme: "https", context_path: "/xxl-job-admin", admin_version: "3.4", environment: "生产", is_production: true });
  });

  it("上下文里的工作台 id 用插件声明的连接工作台", () => {
    install();
    const h = mk();
    expect(h.context("io.t.xxl").workbenchId).toBe("io.t.xxl.workbench");
  });

  it("多个连接可以同时用；改了连接配置下次调用会重连；删除后用不了", async () => {
    install();
    const a = store.save(xxl("A"));
    const b = store.save(xxl("B", { env: "测试" }, { url: "http://10.0.0.2:8080/" }));
    const h = mk();
    h.trust("io.t.xxl");
    const call = (id: string) => h.request("io.t.xxl", "backend.invoke", { method: "xxljob/info", params: { connectionId: id } });
    const rb = (await call(b.id)).result as { conn: { host: string; port: number; config: { context_path: string; scheme: string } }; connects: number };
    expect(rb.conn).toMatchObject({ host: "10.0.0.2", port: 8080 });
    expect(rb.conn.config).toMatchObject({ scheme: "http", context_path: "/" });
    const ra = (await call(a.id)).result as { connects: number };
    expect(ra.connects).toBe(2);

    store.save(xxl("A", { id: a.id }, { url: "http://changed.example.com/" }));
    const ra2 = (await call(a.id)).result as { conn: { host: string } };
    expect(ra2.conn.host).toBe("changed.example.com");

    store.remove(b.id);
    const gone = await call(b.id);
    expect(gone.ok).toBe(false);
    expect(gone.error).toContain("不存在");
  });

  it("后台说连接断了，会自动重连再试一次", async () => {
    install();
    const c = store.save(xxl("A"));
    const h = mk();
    h.trust("io.t.xxl");
    const call = (method: string) => h.request("io.t.xxl", "backend.invoke", { method, params: { connectionId: c.id } });
    expect((await call("xxljob/info")).ok).toBe(true);
    await call("drop");
    expect((await call("xxljob/info")).ok).toBe(true);
  });

  it("停用的连接、别的类型的连接、地址不合法的连接都连不上，给出原因", async () => {
    install();
    const off = store.save(xxl("停用"));
    store.setEnabled(off.id, false);
    const redis = store.save({ kind: "redis", name: "r", env: "测试", machine: "", fields: { ...DEFAULTS.redis, host: "h" } });
    const h = mk();
    h.trust("io.t.xxl");
    for (const id of [off.id, redis.id, "nope"]) {
      const r = await h.request("io.t.xxl", "backend.invoke", { method: "xxljob/info", params: { connectionId: id } });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("设置");
    }
  });

  it("不带 connectionId 的调用照常转发，不碰连接", async () => {
    install();
    const h = mk();
    h.trust("io.t.xxl");
    const r = await h.request("io.t.xxl", "backend.invoke", { method: "xxljob/info", params: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("尚未建立");
  });
});
