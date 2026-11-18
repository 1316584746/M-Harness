import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionStore } from "../desktop/main/connections";
import { DbEngine } from "../desktop/main/db-engine";
import type { DbDriver } from "../desktop/main/db-drivers";
import { PluginHost } from "../desktop/main/pluginhost";
import { DEFAULTS, type ConnectionInput } from "../desktop/shared/connections";

let tmp: string;
let store: ConnectionStore;
let driverSql: string[];
let driverCfgs: Array<{ host: string; database?: string }>;
const hosts: PluginHost[] = [];

function install(id: string, perms: string[], backend = false) {
  const dir = path.join(tmp, "plugins", id, "versions", "1.0.0");
  fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ui", "index.html"), "<html><head></head><body>x</body></html>");
  const m: Record<string, unknown> = { id, name: id, version: "1.0.0", permissions: perms, entrypoints: { ui: { root: "ui", entry: "ui/index.html" } }, contributions: [{ type: "workbench", id: id + ".wb" }] };
  if (backend) {
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bin", "s.js"), "setInterval(()=>{},1000)");
    (m.entrypoints as Record<string, unknown>).backend = { executable: "bin/s.js" };
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m));
}

const fakeDriver = async (_d: string, cfg: { host: string; database?: string }): Promise<DbDriver> => {
  driverCfgs.push(cfg);
  return {
    dialect: "postgresql",
    alive: () => true,
    version: async () => "16",
    query: async (sql, o) => {
      driverSql.push(sql);
      if (sql.includes("information_schema")) return { columns: [], rows: [["id", "integer", "NO", null, 32, 0, null]], truncated: false };
      return { columns: [{ name: "n", dataType: "int4" }], rows: [[1], [2]].slice(0, o.maxRows), truncated: false };
    },
    close: async () => {},
  };
};

function mk(withDb = true): PluginHost {
  const engine = new DbEngine({
    connections: {
      list: () => store.list(),
      get: id => {
        const conn = store.get(id);
        return conn && { conn, secrets: store.secretsOf(id) };
      },
    },
    driver: fakeDriver as never,
  });
  const h = new PluginHost({
    localDir: path.join(tmp, "plugins"),
    dataRoot: path.join(tmp, "data"),
    consentFile: path.join(tmp, "consent.json"),
    grantsFile: path.join(tmp, "grants.json"),
    launch: exe => ({ command: process.execPath, args: [exe] }),
    connections: {
      list: kind => store.list().filter(c => c.kind === kind),
      get: id => {
        const conn = store.get(id);
        return conn && { conn, secrets: store.secretsOf(id) };
      },
    },
    db: withDb ? engine : undefined,
  });
  hosts.push(h);
  return h;
}

const db = (name: string, env: string, fields: Record<string, string> = {}): ConnectionInput => ({
  kind: "database",
  name,
  env,
  machine: "",
  fields: { ...DEFAULTS.database, dbType: "postgresql", host: "db.local", port: "5432", username: "u", database: "app", ...fields },
  secrets: { password: "pw" },
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugdata-"));
  store = new ConnectionStore(path.join(tmp, "home"));
  driverSql = [];
  driverCfgs = [];
});
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stopAll();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const PERMS = ["host.data:read", "host.schema:read", "host.connections:read"];
const ID = "io.t.data";

describe("数据库类插件：读数据要先确认、要选连接", () => {
  it("要读数据库的插件没有后台程序也要先确认；能力开关按声明的权限给", () => {
    install(ID, PERMS);
    install("io.t.plain", ["host.storage"]);
    const h = mk();
    const list = h.list();
    expect(list.find(p => p.id === ID)).toMatchObject({ trusted: false, dataAccess: true, connKind: "database" });
    expect(list.find(p => p.id === "io.t.plain")).toMatchObject({ trusted: true });
    expect(list.find(p => p.id === "io.t.plain")?.dataAccess).toBeUndefined();
    expect(h.capabilities(ID)).toMatchObject({ dataApi: true, schemaMetadataApi: true, connectionsApi: true });
    expect(h.capabilities("io.t.plain")).toMatchObject({ dataApi: false, schemaMetadataApi: false, connectionsApi: false });
  });

  it("没有数据库功能的宿主里，读数据权限不算数", () => {
    install(ID, PERMS);
    const h = mk(false);
    expect(h.list()[0]).toMatchObject({ trusted: true });
    expect(h.capabilities(ID)).toMatchObject({ dataApi: false });
  });

  it("没确认前、没授权的连接，一律查不了", async () => {
    install(ID, PERMS);
    const a = store.save(db("测试库", "测试"));
    const h = mk();
    let r = await h.request(ID, "host.queryData", { connectionId: a.id, sql: "select 1" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("信任") });
    h.trust(ID, []);
    r = await h.request(ID, "host.queryData", { connectionId: a.id, sql: "select 1" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("允许这个插件") });
    expect(driverSql).toEqual([]);
  });

  it("授权后能查；返回 DBX 同形的结果，库类型叫 postgres", async () => {
    install(ID, PERMS);
    const a = store.save(db("测试库", "测试"));
    const h = mk();
    h.trust(ID, [a.id]);
    const r = await h.request(ID, "host.queryData", { connectionId: a.id, sql: "select n from t", maxRows: 1 });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ dbType: "postgres", truncated: false, rowCount: 1, columns: [{ name: "n", dataType: "int4" }], rows: [[1]] });
    const m = await h.request(ID, "host.getTableMetadata", { connectionId: a.id, table: "t" });
    expect(m).toMatchObject({ ok: true, result: { columns: [{ name: "id", dataType: "integer", nullable: false }] } });
  });

  it("生产库的写语句被拦下，不会到数据库；测试库的写语句放行", async () => {
    install(ID, PERMS);
    const a = store.save(db("测试库", "测试"));
    const b = store.save(db("生产库", "生产"));
    const h = mk();
    h.trust(ID, [a.id, b.id]);
    const r = await h.request(ID, "host.queryData", { connectionId: b.id, sql: "delete from t" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("只读") });
    expect(driverSql).toEqual([]);
    const w = await h.request(ID, "host.queryData", { connectionId: a.id, sql: "delete from t" });
    expect(w.ok).toBe(true);
    expect(driverSql).toEqual(["delete from t"]);
    // 测试库也不能改权限、建库
    expect(await h.request(ID, "host.queryData", { connectionId: a.id, sql: "grant all on t to x" })).toMatchObject({ ok: false });
  });

  it("只能用授权过的连接；改授权立刻生效；停用的连接不给", async () => {
    install(ID, PERMS);
    const a = store.save(db("测试库", "测试"));
    const b = store.save(db("生产库", "生产"));
    const h = mk();
    h.trust(ID, [a.id]);
    expect((await h.request(ID, "host.queryData", { connectionId: b.id, sql: "select 1" })).ok).toBe(false);
    expect(h.connectionsFor(ID).map(c => c.id)).toEqual([a.id]);
    h.setGrants(ID, [a.id, b.id]);
    expect((await h.request(ID, "host.queryData", { connectionId: b.id, sql: "select 1" })).ok).toBe(true);
    store.setEnabled(a.id, false);
    expect(h.connectionsFor(ID).map(c => c.id)).toEqual([b.id]);
    const gc = await h.request(ID, "host.getConnections", {});
    expect(gc.result).toEqual([{ id: b.id, name: "生产库", dbType: "postgres", dialect: "postgres", connected: true, readOnly: true, database: "app" }]);
  });

  it("只给了 data 权限的插件，不能读表结构和连接列表", async () => {
    install(ID, ["host.data:read"]);
    const a = store.save(db("测试库", "测试"));
    const h = mk();
    h.trust(ID, [a.id]);
    expect(await h.request(ID, "host.getTableMetadata", { connectionId: a.id, table: "t" })).toMatchObject({ ok: false, error: expect.stringContaining("host.schema:read") });
    expect(await h.request(ID, "host.getConnections", {})).toMatchObject({ ok: false, error: expect.stringContaining("host.connections:read") });
  });

  it("授权记录落在文件里，换个宿主实例还在；不支持的库不出现在可用连接里", () => {
    install(ID, PERMS);
    const a = store.save(db("测试库", "测试"));
    const o = store.save(db("Oracle", "测试", { dbType: "oracle" }));
    const h = mk();
    h.trust(ID, [a.id, o.id]);
    const h2 = mk();
    expect(h2.grants(ID).sort()).toEqual([a.id, o.id].sort());
    expect(h2.connectionsFor(ID).map(c => c.id)).toEqual([a.id]);
    expect(h2.dbAccess(ID).options.find(x => x.id === o.id)).toMatchObject({ supported: false });
  });

  it("连接设置里换了库名后，查询用新库", async () => {
    install(ID, PERMS);
    const a = store.save(db("测试库", "测试"));
    const h = mk();
    h.trust(ID, [a.id]);
    await h.request(ID, "host.queryData", { connectionId: a.id, sql: "select 1", database: "other" });
    expect(driverCfgs[0].database).toBe("other");
  });

  it("带后台程序又读数据库的插件：确认一次同时授权", () => {
    install("io.t.both", PERMS, true);
    const a = store.save(db("测试库", "测试"));
    const h = mk();
    expect(h.list()[0]).toMatchObject({ backend: true, trusted: false, dataAccess: true });
    h.trust("io.t.both", [a.id]);
    expect(h.list()[0].trusted).toBe(true);
    expect(h.grants("io.t.both")).toEqual([a.id]);
  });
});
