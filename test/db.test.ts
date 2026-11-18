import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Connection } from "../desktop/shared/connections";
import { classifySql, isWritableEnv, quoteIdent } from "../desktop/shared/db";
import { DbEngine, DbError } from "../desktop/main/db-engine";
import type { DbDriver, DriverConfig } from "../desktop/main/db-drivers";

const ok = (s: string) => expect(classifySql(s).ok, s).toBe(true);
const bad = (s: string) => expect(classifySql(s).ok, s).toBe(false);

describe("classifySql", () => {
  it("放行普通只读查询", () => {
    ok("select * from users");
    ok("SELECT id, name FROM t WHERE a = 1;");
    ok("  with x as (select 1) select * from x");
    ok("show tables");
    ok("describe users");
    ok("explain select * from t");
    ok("values (1),(2)");
    ok("table users");
  });

  it("不会误伤叫 comment / start / release / created_at 的列，也放行 replace() 函数", () => {
    ok("select comment, start, release, created_at, updated_at from t");
    ok("select replace(name, 'a', 'b') from t");
    ok("select * from t where status = 'update' and note = 'delete me'");
    ok("select 'a;b' as x");
    ok('select "drop" from t');
  });

  it("拦截写入和 DDL", () => {
    bad("insert into t values (1)");
    bad("update t set a = 1");
    bad("delete from t");
    bad("drop table t");
    bad("truncate t");
    bad("create table x(a int)");
    bad("alter table t add b int");
    bad("grant all on t to x");
    bad("call proc()");
    bad("set global x = 1");
    bad("use other");
  });

  it("拦截藏在查询里的写法", () => {
    bad("with d as (delete from t returning *) select * from d");
    bad("with d as (insert into t values (1) returning *) select * from d");
    bad("select * into backup from t");
    bad("select * from t into outfile '/tmp/x'");
    bad("select * from t for update");
    bad("select * from t lock in share mode");
    bad("select replace into t");
    bad("explain analyze select * from t");
  });

  it("拦截多语句、注释绕过和危险函数", () => {
    bad("select 1; drop table t");
    bad("select 1; select 2");
    bad("select /*! 1 */ 1");
    bad("select 'abc");
    bad("select pg_read_file('/etc/passwd')");
    bad("select pg_sleep(100)");
    bad("select sleep(100)");
    bad("select lo_import('/etc/passwd')");
    bad("select * from dblink('x','select 1') as t(a int)");
    bad("select nextval('s')");
    bad("");
    bad("   ;  ");
  });

  it("注释里的写关键字不算数，也不能靠注释拼出语句", () => {
    ok("select 1 -- drop table t");
    ok("select /* delete */ 1");
    bad("sel/**/ect 1");
  });
});

describe("classifySql 写模式（开发 / 测试环境）", () => {
  const w = (s: string) => expect(classifySql(s, true), s).toMatchObject({ ok: true, kind: "write" });
  const r = (s: string) => expect(classifySql(s, true), s).toMatchObject({ ok: true, kind: "read" });
  const no = (s: string) => expect(classifySql(s, true).ok, s).toBe(false);

  it("读语句仍然是读；写语句放行并标成写", () => {
    r("select * from t");
    r("show tables");
    w("insert into t(a) values (1)");
    w("update t set a = 1 where id = 2");
    w("delete from t where id = 1");
    w("replace into t values (1)");
    w("create table x(a int)");
    w("alter table t add b int");
    w("drop table t");
    w("truncate table t");
    w("with d as (delete from t returning *) select * from d");
    w("select * into backup from t");
    w("select * from t for update");
  });

  it("可写的库里，叫 load / notify / call 的列也不会被误拦", () => {
    w("insert into t(load, notify, call) values (1, 2, 3)");
    w("update t set `load` = 1 where `call` = 2");
  });

  it("写模式下仍然拦：多语句、改权限、建库建用户、存储过程、服务器文件、危险函数", () => {
    no("insert into t values (1); drop table t");
    no("grant all on t to x");
    no("revoke all on t from x");
    no("drop database d");
    no("drop schema s");
    no("create user u identified by 'x'");
    no("create database d");
    no("create extension dblink");
    no("create function f() returns int as $$ select 1 $$ language sql");
    no("alter user u with superuser");
    no("select * from t into outfile '/tmp/x'");
    no("call proc()");
    no("set global x = 1");
    no("use other");
    no("copy t to program 'x'");
    no("insert into t values (pg_read_file('/etc/passwd'))");
    no("select sleep(100)");
    no("explain analyze select * from t");
  });

  it("序列函数在可写的库里放行", () => {
    w("insert into t(id) values (nextval('s'))");
  });

  it("环境名：开发 / 测试可写，生产 / 预发 / 没见过的名字一律只读", () => {
    for (const e of ["开发", "测试", "本地", "dev", "Test", "QA"]) expect(isWritableEnv(e), e).toBe(true);
    for (const e of ["生产", "线上", "预发", "prod", "staging", "UAT", "测试-生产", "", "沙盒X1"]) expect(isWritableEnv(e), e).toBe(false);
  });
});

describe("quoteIdent", () => {
  it("按方言加引号并转义", () => {
    expect(quoteIdent("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdent("postgresql", 'a"b')).toBe('"a""b"');
  });
});

// ───────── 引擎（假驱动） ─────────

function conn(over: Partial<Connection> = {}, fields: Record<string, string> = {}): Connection {
  return { id: "c1", kind: "database", name: "测试库", env: "测试", machine: "m1", enabled: true, fields: { dbType: "postgresql", host: "h", port: "5432", username: "u", database: "d", ...fields }, secretSet: { password: true }, createdAt: 1, updatedAt: 1, ...over } as Connection;
}

function fake() {
  const log: string[] = [];
  let opened = 0;
  let closed = 0;
  const cfgs: DriverConfig[] = [];
  const mk = (): DbDriver => {
    let alive = true;
    return {
      dialect: "postgresql",
      alive: () => alive,
      version: async () => "16.0",
      query: async (sql, o) => {
        log.push(sql);
        if (sql.includes("hang")) return new Promise(() => {});
        if (sql.includes("boom")) throw new Error("relation does not exist");
        if (sql.includes("information_schema")) return { columns: [], rows: [["id", "integer", "NO", null, 32, 0, null], ["name", "character varying", "YES", 50, null, null, "'x'::text"]], truncated: false };
        const rows = Array.from({ length: Math.min(o.maxRows, 3) }, (_, i) => [i]);
        return { columns: [{ name: "n", dataType: "int4" }], rows, truncated: false };
      },
      close: async () => {
        alive = false;
        closed++;
      },
    };
  };
  return {
    log,
    cfgs,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    factory: async (_d: string, cfg: DriverConfig) => {
      opened++;
      cfgs.push(cfg);
      return mk();
    },
  };
}

function engine(c: Connection | undefined, f = fake(), extra: object = {}) {
  const e = new DbEngine({ connections: { get: id => (c && id === c.id ? { conn: c, secrets: { password: "pw" } } : undefined), list: () => (c ? [c] : []) }, driver: f.factory as never, ...extra });
  return { e, f };
}

describe("DbEngine", () => {
  it("查询返回列、行和耗时，连接复用", async () => {
    const { e, f } = engine(conn());
    const r = await e.query({ connectionId: "c1", sql: "select 1" });
    expect(r.rowCount).toBe(3);
    expect(r.columns[0].name).toBe("n");
    await e.query({ connectionId: "c1", sql: "select 2" });
    expect(f.opened).toBe(1);
    expect(f.cfgs[0]).toMatchObject({ host: "h", port: 5432, user: "u", password: "pw", database: "d", tls: false });
    await e.closeAll();
    expect(f.closed).toBe(1);
  });

  it("生产 / 预发的库只读：写语句在进驱动前就被拦下，并说明原因", async () => {
    for (const env of ["生产", "预发", "自己起的名字"]) {
      const { e, f } = engine(conn({ env }));
      await expect(e.query({ connectionId: "c1", sql: "delete from t" })).rejects.toMatchObject({ code: "readonly", message: expect.stringContaining("只读") });
      expect(f.opened).toBe(0);
    }
  });

  it("测试库可写：写语句带着 write 标记进驱动，返回影响行数；读语句不带", async () => {
    const f = fake();
    const seen: Array<boolean | undefined> = [];
    const orig = f.factory;
    f.factory = async (d, c) => {
      const drv = await orig(d, c);
      const q = drv.query;
      drv.query = async (s, o) => {
        seen.push(o.write);
        const r = await q(s, o);
        return o.write ? { ...r, columns: [], rows: [], affectedRows: 7 } : r;
      };
      return drv;
    };
    const { e } = engine(conn({ env: "测试" }), f);
    const w = await e.query({ connectionId: "c1", sql: "update t set a = 1" });
    expect(w).toMatchObject({ affectedRows: 7, rowCount: 0 });
    const r = await e.query({ connectionId: "c1", sql: "select 1" });
    expect(r.affectedRows).toBeUndefined();
    expect(seen).toEqual([true, false]);
    // 就算是测试库，改权限、建库这些也不行
    await expect(e.query({ connectionId: "c1", sql: "drop database d" })).rejects.toMatchObject({ code: "readonly" });
  });

  it("行数上限被夹在 5000 以内", async () => {
    const seen: number[] = [];
    const f = fake();
    const orig = f.factory;
    f.factory = async (d, c) => {
      const drv = await orig(d, c);
      const q = drv.query;
      drv.query = (s, o) => (seen.push(o.maxRows), q(s, o));
      return drv;
    };
    const { e } = engine(conn(), f);
    await e.query({ connectionId: "c1", sql: "select 1", maxRows: 10_000_000 });
    await e.query({ connectionId: "c1", sql: "select 1" });
    expect(seen).toEqual([5000, 1000]);
  });

  it("连接不存在 / 已停用 / 不是数据库 / 类型不支持", async () => {
    await expect(engine(undefined).e.query({ connectionId: "x", sql: "select 1" })).rejects.toMatchObject({ code: "not_found" });
    await expect(engine(conn({ enabled: false })).e.query({ connectionId: "c1", sql: "select 1" })).rejects.toMatchObject({ code: "disabled" });
    await expect(engine(conn({ kind: "redis" })).e.query({ connectionId: "c1", sql: "select 1" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(engine(conn({}, { dbType: "oracle" })).e.query({ connectionId: "c1", sql: "select 1" })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("超时后取消并断开会话，下一次重新连", async () => {
    const { e, f } = engine(conn());
    await expect(e.query({ connectionId: "c1", sql: "select hang", timeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" });
    expect(f.closed).toBe(1);
    await e.query({ connectionId: "c1", sql: "select 1" });
    expect(f.opened).toBe(2);
  });

  it("数据库报错原样带回；改了连接配置会换会话", async () => {
    const c = conn();
    const { e, f } = engine(c);
    await expect(e.query({ connectionId: "c1", sql: "select boom" })).rejects.toThrow("relation does not exist");
    c.fields = { ...c.fields, host: "other" };
    await e.query({ connectionId: "c1", sql: "select 1" });
    expect(f.opened).toBe(2);
    expect(f.cfgs[1].host).toBe("other");
  });

  it("closeConnection 断开该连接的会话", async () => {
    const { e, f } = engine(conn());
    await e.query({ connectionId: "c1", sql: "select 1" });
    await e.closeConnection("c1");
    expect(f.closed).toBe(1);
  });

  it("表结构：列、类型、可空、长度、默认值", async () => {
    const { e } = engine(conn());
    const m = await e.tableMetadata({ connectionId: "c1", table: "users" });
    expect(m.columns).toEqual([
      { name: "id", dataType: "integer", nullable: false, length: null, precision: 32, scale: 0, default: null },
      { name: "name", dataType: "character varying", nullable: true, length: 50, precision: null, scale: null, default: "'x'::text" },
    ]);
    await expect(e.tableMetadata({ connectionId: "c1", table: "" })).rejects.toBeInstanceOf(DbError);
  });

  it("options 只列数据库连接，并标出是否支持", () => {
    const { e } = engine(conn());
    expect(e.options()).toEqual([{ id: "c1", name: "测试库", env: "测试", machine: "m1", dbType: "postgresql", supported: true, writable: true }]);
  });

  it("审计日志记下语句和结果，不含结果内容", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-audit-"));
    const file = path.join(dir, "audit.jsonl");
    const { e } = engine(conn({ env: "生产" }), fake(), { auditFile: file });
    await e.query({ connectionId: "c1", sql: "select 1" }, "plugin-a");
    await e.query({ connectionId: "c1", sql: "drop table t" }, "plugin-a").catch(() => {});
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ who: "plugin-a", conn: "c1", sql: "select 1", ok: true, rows: 3 });
    expect(lines[1]).toMatchObject({ ok: false });
    expect(JSON.stringify(lines)).not.toContain("pw");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
