import { describe, expect, it } from "vitest";
import type { Connection } from "../desktop/shared/connections";
import { classifySql } from "../desktop/shared/db";
import { DbEngine } from "../desktop/main/db-engine";
import type { DbDriver, DriverConfig, DriverStmt } from "../desktop/main/db-drivers";
import { buildCount, buildOps, buildSelect } from "../desktop/main/db-sql";
import { applyItem, complete, referencedTables, type CompColumn, type CompSource } from "../desktop/renderer/src/lib/sqlComplete";
import { formatDbPreamble } from "../desktop/renderer/src/lib/dbPreamble";
import { buildOrder, buildWhere, literal, type Cond, type FilterOp, type SortKey } from "../desktop/renderer/src/lib/filterSql";
import { cellText, isLossy, isReadSql, splitStatements, statementAt, toCsv, toInsertSql, toJson, tokenize } from "../desktop/renderer/src/lib/sqlText";

// ───────── SQL 拼装 ─────────

describe("buildSelect / buildCount", () => {
  it("带条件、排序、分页，全名按方言加引号", () => {
    const sql = buildSelect("postgresql", "public", "c_user", { where: "id > 5", orderBy: '"id" DESC', limit: 50, offset: 100 });
    expect(sql).toContain('FROM "public"."c_user"');
    expect(sql).toContain("WHERE (\nid > 5\n)");
    expect(sql).toContain('ORDER BY\n"id" DESC\n');
    expect(sql).toMatch(/LIMIT 50 OFFSET 100$/);
    expect(buildSelect("mysql", "shop", "t", {})).toBe("SELECT * FROM `shop`.`t`\nLIMIT 200");
  });

  it("用户写的 -- 注释吃不掉后面的 LIMIT；结尾分号被去掉", () => {
    const sql = buildSelect("postgresql", "public", "t", { where: "a = 1 -- 只看这个;", orderBy: "id;" });
    expect(sql).toContain("a = 1 -- 只看这个\n)");
    expect(sql).toContain("ORDER BY\nid\n");
    expect(sql).toContain("\nLIMIT 200");
    expect(classifySql(sql).ok).toBe(true);
  });

  it("每页行数夹在 1 到 5000；表名里的引号被转义", () => {
    expect(buildSelect("postgresql", "public", "t", { limit: 999999 })).toMatch(/LIMIT 5000$/);
    expect(buildSelect("postgresql", "public", "t", { limit: -3 })).toMatch(/LIMIT 1$/);
    expect(buildSelect("postgresql", 's"x', 'a"b', {})).toContain('"s""x"."a""b"');
  });

  it("统计行数带同样的条件", () => {
    expect(buildCount("mysql", "d", "t", "a = 1;")).toBe("SELECT COUNT(*) FROM `d`.`t`\nWHERE (\na = 1\n)");
    expect(buildCount("postgresql", "public", "t")).toBe('SELECT COUNT(*) FROM "public"."t"');
  });

  it("条件里夹带第二条语句、/*! 之类的，整句过不了只读检查", () => {
    for (const where of ["1=1; drop table t", "1=1) OR (1=1; delete from t", "a = 1 /*! DROP TABLE t */", "id IN (SELECT 1) FOR UPDATE"]) {
      expect(classifySql(buildSelect("postgresql", "public", "t", { where })).ok, where).toBe(false);
    }
    expect(classifySql(buildSelect("postgresql", "public", "t", { where: "name LIKE '%create%' AND update_time > now() - interval '1 day'" })).ok).toBe(true);
  });
});

describe("buildOps", () => {
  it("PostgreSQL：值走 $n 参数，主键条件接在后面", () => {
    const [ins, upd, del] = buildOps("postgresql", "public", "t", [
      { kind: "insert", values: { name: "a", n: 1 } },
      { kind: "update", key: { id: "7" }, values: { name: "b", note: null } },
      { kind: "delete", key: { id: "7", ver: 2 } },
    ]);
    expect(ins).toEqual({ sql: 'INSERT INTO "public"."t" ("name", "n") VALUES ($1, $2)', params: ["a", 1], expect: 1 });
    expect(upd).toEqual({ sql: 'UPDATE "public"."t" SET "name" = $1, "note" = $2 WHERE "id" = $3', params: ["b", null, "7"], expect: 1 });
    expect(del).toEqual({ sql: 'DELETE FROM "public"."t" WHERE "id" = $1 AND "ver" = $2', params: ["7", 2], expect: 1 });
  });

  it("MySQL 用 ?；什么都没填的新增行用默认值", () => {
    const [upd, ins] = buildOps("mysql", "shop", "t", [
      { kind: "update", key: { id: 1 }, values: { name: "x" } },
      { kind: "insert", values: {} },
    ]);
    expect(upd.sql).toBe("UPDATE `shop`.`t` SET `name` = ? WHERE `id` = ?");
    expect(upd.params).toEqual(["x", 1]);
    expect(ins.sql).toBe("INSERT INTO `shop`.`t` () VALUES ()");
    expect(buildOps("postgresql", "public", "t", [{ kind: "insert", values: {} }])[0].sql).toBe('INSERT INTO "public"."t" DEFAULT VALUES');
  });

  it("值里的引号、分号只是参数，不会进 SQL 文本；列名里的引号被转义", () => {
    const [s] = buildOps("postgresql", "public", "t", [{ kind: "update", key: { id: 1 }, values: { 'a"b': "x'; drop table t; --" } }]);
    expect(s.sql).toBe('UPDATE "public"."t" SET "a""b" = $1 WHERE "id" = $2');
    expect(s.sql).not.toContain("drop");
  });

  it("没有主键 / 主键为空 / 没有要改的字段：直接报错，不拼出会误伤整表的语句", () => {
    expect(() => buildOps("postgresql", "public", "t", [{ kind: "delete", key: {} }])).toThrow(/没有主键/);
    expect(() => buildOps("postgresql", "public", "t", [{ kind: "update", key: { id: null }, values: { a: 1 } }])).toThrow(/主键 id 是空的/);
    expect(() => buildOps("postgresql", "public", "t", [{ kind: "update", key: { id: 1 }, values: {} }])).toThrow(/没有要修改/);
  });
});

// ───────── 引擎（假驱动） ─────────

function conn(over: Partial<Connection> = {}, fields: Record<string, string> = {}): Connection {
  return { id: "c1", kind: "database", name: "测试库", env: "测试", machine: "m1", enabled: true, fields: { dbType: "postgresql", host: "h", port: "5432", username: "u", database: "d", ...fields }, secretSet: { password: true }, createdAt: 1, updatedAt: 1, ...over } as Connection;
}

type Reply = (sql: string, params?: unknown[]) => unknown[][] | undefined;

function fake(reply: Reply = () => undefined) {
  const queries: Array<{ sql: string; params?: unknown[]; write?: boolean }> = [];
  const execs: DriverStmt[][] = [];
  const cfgs: DriverConfig[] = [];
  let failExec: string | undefined;
  let execCount: number[] | undefined;
  const factory = async (_d: string, cfg: DriverConfig): Promise<DbDriver> => {
    cfgs.push(cfg);
    return {
      dialect: "postgresql",
      alive: () => true,
      version: async () => "16",
      query: async (sql, o) => {
        queries.push({ sql, params: o.params, write: o.write });
        const rows = reply(sql, o.params) ?? [[1]];
        return { columns: rows[0] ? rows[0].map((_, i) => ({ name: `c${i}`, dataType: "text" })) : [], rows, truncated: false };
      },
      exec: async stmts => {
        execs.push(stmts);
        if (failExec) throw new Error(failExec);
        return execCount ?? stmts.map(() => 1);
      },
      close: async () => {},
    };
  };
  return {
    queries,
    execs,
    cfgs,
    factory,
    failWith: (m: string) => (failExec = m),
    count: (c: number[]) => (execCount = c),
  };
}

function engine(c: Connection, f = fake()) {
  const e = new DbEngine({ connections: { get: id => (id === c.id ? { conn: c, secrets: { password: "pw" } } : undefined), list: () => [c] }, driver: f.factory as never });
  return { e, f };
}

describe("DbEngine：浏览", () => {
  it("PostgreSQL：库列表、schema 列表、表列表（区分表和视图）", async () => {
    const { e, f } = engine(
      conn(),
      fake(sql => {
        if (sql.includes("pg_database")) return [["d"], ["other"]];
        if (sql.includes("pg_namespace") && !sql.includes("pg_class")) return [["public", "standard public schema"], ["audit", null]];
        if (sql.includes("pg_class")) return [["orders", "r", "1200", "订单"], ["v_orders", "v", "-1", null]];
        return undefined;
      }),
    );
    expect(await e.listDatabases("c1")).toEqual(["d", "other"]);
    expect(await e.listSchemas({ connectionId: "c1", database: "other" })).toEqual([
      { name: "public", comment: "standard public schema" },
      { name: "audit", comment: undefined },
    ]);
    const t = await e.listTables({ connectionId: "c1", database: "other", schema: "public" });
    expect(t).toEqual([
      { name: "orders", kind: "table", rows: 1200, comment: "订单" },
      { name: "v_orders", kind: "view", rows: null, comment: undefined },
    ]);
    // 看别的库要换会话：连的是 other
    expect(f.cfgs.map(c => c.database)).toEqual(["d", "other"]);
    expect(f.queries.find(q => q.sql.includes("pg_class"))?.params).toEqual(["public"]);
  });

  it("MySQL：schema 层不存在；库名就是 schema，表按 TABLE_SCHEMA 查", async () => {
    const { e, f } = engine(
      conn({}, { dbType: "mysql", port: "3306" }),
      fake(sql => (sql.includes("TABLE_TYPE") ? [["t1", "BASE TABLE", "5", ""], ["v1", "VIEW", null, "视图"]] : undefined)),
    );
    expect(await e.listSchemas({ connectionId: "c1" })).toEqual([]);
    const t = await e.listTables({ connectionId: "c1", schema: "shop" });
    expect(t.map(x => [x.name, x.kind])).toEqual([["t1", "table"], ["v1", "view"]]);
    expect(f.queries[0].params).toEqual(["shop"]);
  });

  it("PostgreSQL：扩展和事件触发器（MySQL 没有这两样，返回空）", async () => {
    const { e } = engine(
      conn(),
      fake(sql => {
        if (sql.includes("pg_extension")) return [["plpgsql", "1.0", "PL/pgSQL procedural language"], ["pg_trgm", "1.6", null]];
        if (sql.includes("pg_event_trigger")) return [["audit_ddl", "ddl_command_end", true], ["off_one", "sql_drop", false]];
        return undefined;
      }),
    );
    expect(await e.listExtensions({ connectionId: "c1" })).toEqual([
      { name: "plpgsql", version: "1.0", comment: "PL/pgSQL procedural language" },
      { name: "pg_trgm", version: "1.6", comment: undefined },
    ]);
    expect(await e.listEventTriggers({ connectionId: "c1" })).toEqual([
      { name: "audit_ddl", event: "ddl_command_end", enabled: true },
      { name: "off_one", event: "sql_drop", enabled: false },
    ]);
    const my = engine(conn({}, { dbType: "mysql" })).e;
    expect(await my.listExtensions({ connectionId: "c1" })).toEqual([]);
    expect(await my.listEventTriggers({ connectionId: "c1" })).toEqual([]);
  });

  it("表结构：字段（含主键、可空、默认值、备注）和索引", async () => {
    const { e } = engine(
      conn(),
      fake(sql => {
        if (sql.includes("format_type")) return [["id", "integer", false, "nextval('t_id_seq'::regclass)", null, true], ["name", "character varying(20)", true, null, "名字", false]];
        if (sql.includes("pg_index ix")) return [["t_pkey", true, true, "id", "btree"]];
        if (sql.includes("relkind IN")) return [[false]];
        return undefined;
      }),
    );
    const s = await e.structure({ connectionId: "c1", table: "t" });
    expect(s.view).toBe(false);
    expect(s.columns).toEqual([
      { name: "id", dataType: "integer", nullable: false, default: "nextval('t_id_seq'::regclass)", comment: "", pk: true },
      { name: "name", dataType: "character varying(20)", nullable: true, default: null, comment: "名字", pk: false },
    ]);
    expect(s.indexes).toEqual([{ name: "t_pkey", columns: "id", unique: true, primary: true, method: "btree" }]);
  });

  it("表不存在：给清楚的提示", async () => {
    const { e } = engine(conn(), fake(() => []));
    await expect(e.structure({ connectionId: "c1", table: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("看表数据：拼成带分页的 SELECT，走和用户 SQL 同一条检查", async () => {
    const f = fake();
    const { e } = engine(conn(), f);
    const r = await e.tableData({ connectionId: "c1", schema: "public", table: "t", where: "id > 1", orderBy: '"id" DESC', limit: 20, offset: 40 });
    expect(r.rowCount).toBe(1);
    const q = f.queries[f.queries.length - 1];
    expect(q.sql).toContain('FROM "public"."t"');
    expect(q.sql).toMatch(/LIMIT 20 OFFSET 40$/);
    await expect(e.tableData({ connectionId: "c1", schema: "public", table: "t", where: "1=1; delete from t" })).rejects.toMatchObject({ code: "readonly" });
  });

  it("统计总数", async () => {
    const { e } = engine(conn(), fake(() => [["1234"]]));
    expect(await e.tableCount({ connectionId: "c1", schema: "public", table: "t", where: "a = 1" })).toBe(1234);
  });
});

describe("DbEngine：改数据", () => {
  const ref = { connectionId: "c1", schema: "public", table: "t" };

  it("测试库：一批操作交给驱动在一个事务里执行，返回每条影响的行数", async () => {
    const f = fake();
    const { e } = engine(conn(), f);
    const r = await e.applyRows({ ...ref, ops: [{ kind: "update", key: { id: 1 }, values: { name: "x" } }, { kind: "delete", key: { id: 2 } }] });
    expect(r.affected).toEqual([1, 1]);
    expect(f.execs).toHaveLength(1);
    expect(f.execs[0].map(s => s.sql)).toEqual(['UPDATE "public"."t" SET "name" = $1 WHERE "id" = $2', 'DELETE FROM "public"."t" WHERE "id" = $1']);
    expect(f.execs[0].every(s => s.expect === 1)).toBe(true);
  });

  it("生产 / 预发 / 没见过的环境：在进驱动前就拦下", async () => {
    for (const env of ["生产", "预发", "我自己起的名字"]) {
      const f = fake();
      const { e } = engine(conn({ env }), f);
      await expect(e.applyRows({ ...ref, ops: [{ kind: "delete", key: { id: 1 } }] })).rejects.toMatchObject({ code: "readonly", message: expect.stringContaining("只读") });
      expect(f.execs).toHaveLength(0);
      expect(f.cfgs).toHaveLength(0);
    }
  });

  it("驱动报错（比如影响行数不对）：错误原样抛出，界面据此提示整批都没生效", async () => {
    const f = fake();
    f.failWith("第 1 条影响了 0 行（应该是 1 行），已全部撤销");
    const { e } = engine(conn(), f);
    await expect(e.applyRows({ ...ref, ops: [{ kind: "update", key: { id: 1 }, values: { a: 1 } }] })).rejects.toThrow(/已全部撤销/);
  });

  it("没有主键 / 空操作 / 太多 / 值类型不对：都是请求错误，不进驱动", async () => {
    const f = fake();
    const { e } = engine(conn(), f);
    await expect(e.applyRows({ ...ref, ops: [{ kind: "delete", key: {} }] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(e.applyRows({ ...ref, ops: [] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(e.applyRows({ ...ref, ops: Array.from({ length: 501 }, () => ({ kind: "insert" as const, values: {} })) })).rejects.toMatchObject({ code: "bad_request" });
    await expect(e.applyRows({ ...ref, ops: [{ kind: "insert", values: { a: { x: 1 } as never } }] })).rejects.toMatchObject({ code: "bad_request" });
    expect(f.execs).toHaveLength(0);
  });
});

// ───────── 可视化筛选 / 排序 → SQL ─────────

describe("filterSql", () => {
  const types = { id: "integer", name: "character varying(20)", created: "timestamp without time zone", data: "jsonb" };
  const c = (col: string, op: FilterOp, val = "", on = true): Cond => ({ id: 1, col, op, val, on });

  it("等于 / 比较：数字列的数字值不加引号，其他加引号；引号翻倍", () => {
    expect(buildWhere("postgresql", [c("id", "eq", "5"), c("name", "ne", "it's"), c("created", "ge", "2026-01-01")], types)).toBe(`"id" = 5 AND "name" <> 'it''s' AND "created" >= '2026-01-01'`);
    // 数字列填了不是数字的值：当字符串，让数据库报错，而不是悄悄拼进去
    expect(buildWhere("postgresql", [c("id", "eq", "5 OR 1=1")], types)).toBe(`"id" = '5 OR 1=1'`);
  });

  it("包含 / 开头 / 结尾：PostgreSQL 用 ILIKE 并把列转成文本；MySQL 用 LIKE", () => {
    expect(buildWhere("postgresql", [c("data", "contains", "abc")], types)).toBe(`"data"::text ILIKE '%abc%'`);
    expect(buildWhere("mysql", [c("name", "starts", "ab"), c("name", "notcontains", "x")], types)).toBe("`name` LIKE 'ab%' AND `name` NOT LIKE '%x%'");
    expect(buildWhere("postgresql", [c("name", "ends", "z")], types)).toBe(`"name"::text ILIKE '%z'`);
  });

  it("为空 / 不为空不需要值；列表用逗号分隔（半角全角都行）", () => {
    expect(buildWhere("mysql", [c("name", "null"), c("id", "notnull")], types)).toBe("`name` IS NULL AND `id` IS NOT NULL");
    expect(buildWhere("postgresql", [c("id", "in", "1, 2，3"), c("name", "notin", "a,b")], types)).toBe(`"id" IN (1, 2, 3) AND "name" NOT IN ('a', 'b')`);
  });

  it("没选字段 / 缺值 / 停用的条件被忽略；任一条件用 OR", () => {
    expect(buildWhere("postgresql", [c("", "eq", "1"), c("id", "eq", ""), c("id", "eq", "1", false), c("name", "eq", "a")], types)).toBe(`"name" = 'a'`);
    expect(buildWhere("postgresql", [c("id", "eq", "1"), c("id", "eq", "2")], types, "or")).toBe(`"id" = 1 OR "id" = 2`);
    expect(buildWhere("postgresql", [], types)).toBe("");
  });

  it("值里的反斜杠：MySQL 翻倍；PostgreSQL 用 E'' 写法；都能过只读检查", () => {
    expect(literal("mysql", "a\\b", "text")).toBe("'a\\\\b'");
    expect(literal("postgresql", "a\\b", "text")).toBe("E'a\\\\b'");
    for (const dialect of ["mysql", "postgresql"] as const) {
      const where = buildWhere(dialect, [c("name", "eq", "x\\"), c("name", "contains", "'; drop table t; --")], types);
      expect(classifySql(buildSelect(dialect, "public", "t", { where })).ok, dialect).toBe(true);
    }
  });

  it("排序：多个字段，跳过停用和没选字段的", () => {
    const s = (col: string, dir: "asc" | "desc", on = true): SortKey => ({ id: 1, col, dir, on });
    expect(buildOrder("postgresql", [s("id", "desc"), s("", "asc"), s("name", "asc", false), s("created", "asc")])).toBe(`"id" DESC, "created" ASC`);
    expect(buildOrder("mysql", [])).toBe("");
  });
});

// ───────── AI 助手的数据库上下文 ─────────

describe("formatDbPreamble", () => {
  const pgConn = { name: "测试库", env: "测试", fields: { dbType: "postgresql", database: "app" } };
  it("带上连接、环境、库、schema、表清单和打开的表的字段；不含密码", () => {
    const s = formatDbPreamble({
      conn: { ...pgConn, fields: { ...pgConn.fields, password: "p@ss-secret" } },
      scope: { database: "app", schema: "public" },
      tables: [{ name: "users", kind: "table" }, { name: "v_active", kind: "view" }],
      table: "users",
      structure: { view: false, columns: [{ name: "id", dataType: "integer", nullable: false, default: null, pk: true, comment: "主键" }, { name: "email", dataType: "text", nullable: true, default: null, pk: false, comment: "" }], indexes: [] },
    });
    expect(s).toContain("连接：测试库（环境：测试，PostgreSQL，可写）");
    expect(s).toContain("库：app　schema：public");
    expect(s).toContain("users、v_active(视图)");
    expect(s).toContain("- id integer 主键 非空 -- 主键");
    expect(s).toContain("- email text");
    expect(s).not.toContain("p@ss-secret");
    expect(s.trimEnd().endsWith("【问题】")).toBe(true);
  });
  it("生产环境标只读；MySQL 不写 schema；表太多时截断", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ name: `t${i}`, kind: "table" as const }));
    const s = formatDbPreamble({ conn: { name: "线上", env: "生产", fields: { dbType: "mysql" } }, scope: { database: "shop", schema: "" }, tables: many });
    expect(s).toContain("MySQL，只读");
    expect(s).not.toContain("schema：");
    expect(s).toContain("共 200 张，只列前 150 张");
    expect(s).toContain("t149");
    expect(s).not.toContain("t150");
  });
});

// ───────── SQL 联想补齐 ─────────

describe("sqlComplete", () => {
  const cols: Record<string, CompColumn[]> = {
    users: [{ name: "id", dataType: "integer", pk: true }, { name: "email", dataType: "text" }, { name: "created_at", dataType: "timestamp" }],
    orders: [{ name: "id", dataType: "integer", pk: true }, { name: "user_id", dataType: "integer" }, { name: "total", dataType: "numeric" }],
  };
  const src = (dialect: "postgresql" | "mysql" = "postgresql"): CompSource => ({
    dialect,
    schema: "public",
    tables: [{ name: "users", kind: "table" }, { name: "orders", kind: "table" }, { name: "v_active", kind: "view" }, { name: "Mixed Case", kind: "table" }],
    schemas: ["public", "audit"],
    columns: (_s, t) => cols[t],
    tablesIn: s => (s === "audit" ? [{ name: "audit_log", kind: "table" }] : []),
  });
  const at = (sql: string, explicit = false, s = src()) => complete(sql, sql.length, s, explicit);
  const labels = (r: ReturnType<typeof complete>) => r?.items.map(i => i.label) ?? [];

  it("sel：片段排第一，后面是 SELECT 等；按顺序命中的也能找到（SERIAL）", () => {
    const r = at("sel")!;
    expect(r.items[0]).toMatchObject({ kind: "snippet", label: "select *", insert: "SELECT * FROM  LIMIT 100;", cursor: 14 });
    expect(labels(r)).toContain("SELECT");
    expect(labels(r)).toContain("SERIAL");
    expect(r.items[0].detail).toBe("SELECT * FROM table LIMIT 100;");
  });

  it("FROM 后面先给表和视图；没输入时只有手动唤起才弹", () => {
    const r = at("select * from us")!;
    expect(r.items[0]).toMatchObject({ label: "users", kind: "table", insert: "users" });
    expect(at("select * from ")).toBeNull();
    const all = at("select * from ", true)!;
    expect(all.items.slice(0, 4).every(i => i.kind === "table" || i.kind === "view")).toBe(true);
    expect(labels(all)).toContain("v_active");
    expect(all.items.some(i => i.kind === "function")).toBe(false);
  });

  it("名字带空格 / 大写要加引号；自己已经打了引号就接着引号补", () => {
    expect(at("select * from Mi")!.items[0].insert).toBe('"Mixed Case"');
    const r = at('select * from "us')!;
    expect(r.items[0].insert).toBe('"users"');
    expect(applyItem('select * from "us', r, r.items[0]).value).toBe('select * from "users"');
    const my = at("select * from Mi", false, src("mysql"))!;
    expect(my.items[0].insert).toBe("`Mixed Case`");
  });

  it("SELECT / WHERE 后面先给语句里用到的表的字段", () => {
    const sql = "select e from users";
    const r = complete(sql, 8, src())!;
    expect(r.items[0]).toMatchObject({ label: "email", kind: "column", detail: "text" });
    const w = complete("select 1 from orders where u", 28, src())!;
    expect(w.items[0]).toMatchObject({ label: "user_id", kind: "column" });
  });

  it("别名. / 表名. 后面给这张表的字段；schema. 后面给它的表", () => {
    const a = complete("select u. from users u", 9, src())!;
    expect(labels(a)).toEqual(["id", "email", "created_at"]);
    expect(a.items[0].detail).toBe("integer");
    expect(labels(complete("select users.em", 15, src()))).toEqual(["email"]);
    expect(labels(at("select * from audit."))).toEqual(["audit_log"]);
    expect(at("select zzz.")).toBeNull();
  });

  it("多张表的字段带上来源；字符串、注释里不弹", () => {
    const r = complete("select i from users u join orders o on 1=1", 8, src())!;
    expect(r.items.filter(i => i.label === "id").map(i => i.detail)).toEqual(["integer · u", "integer · o"]);
    expect(at("select 'us")).toBeNull();
    expect(at("select 1 -- us")).toBeNull();
    expect(at("/* us")).toBeNull();
    expect(at("select 'a' || us")).not.toBeNull();
  });

  it("选中后写进 SQL：函数带括号光标在里面；替换整个词", () => {
    const f = at("select cou")!;
    expect(f.items[0]).toMatchObject({ label: "COUNT", kind: "function", insert: "COUNT()", cursor: 6 });
    const t = at("select * from us")!;
    const out = applyItem("select * from us", t, t.items[0]);
    expect(out).toEqual({ value: "select * from users", caret: 19 });
    const mid = complete("select * from usxx", 16, src())!;
    expect(applyItem("select * from usxx", mid, mid.items.find(i => i.label === "users")!).value).toBe("select * from users");
  });

  it("一条语句里只看自己这一条；完整敲完唯一的词不再弹", () => {
    const sql = "select * from orders;\nselect e from users";
    expect(complete(sql, sql.indexOf("e from") + 1, src())!.items[0].label).toBe("email");
    expect(at("select * from orders")).toBeNull();
  });

  it("referencedTables：别名、schema、逗号分隔、JOIN 后的 ON 不算别名", () => {
    expect(referencedTables('select * from a x, b join public.c as cc on 1=1 left join "D e" on true')).toEqual([
      { schema: undefined, table: "a", alias: "x" },
      { schema: undefined, table: "b", alias: undefined },
      { schema: "public", table: "c", alias: "cc" },
      { schema: undefined, table: "D e", alias: undefined },
    ]);
  });
});

// ───────── 前端的 SQL 文本工具 ─────────

describe("sqlText", () => {
  it("高亮分词：关键字、函数、字符串、带引号的标识符、数字、注释", () => {
    const t = tokenize(`SELECT count(*), "a b" FROM t WHERE x = 'it''s' AND n > 10 -- 注释`);
    const kinds = t.filter(x => x.k !== "txt").map(x => `${x.k}:${x.s}`);
    expect(kinds).toEqual(["kw:SELECT", "fn:count", 'id:"a b"', "kw:FROM", "kw:WHERE", "str:'it''s'", "kw:AND", "num:10", "com:-- 注释"]);
    expect(t.map(x => x.s).join("")).toBe(`SELECT count(*), "a b" FROM t WHERE x = 'it''s' AND n > 10 -- 注释`);
  });

  it("按分号切语句时，引号和注释里的分号不算", () => {
    const sql = "select 'a;b'; -- x;\nselect 2;\nselect 3";
    expect(splitStatements(sql).map(s => s.text.trim())).toEqual(["select 'a;b';", "-- x;\nselect 2;", "select 3"]);
    expect(splitStatements(" ; ;\n-- 只有注释\n")).toEqual([]);
  });

  it("按光标取当前语句", () => {
    const sql = "select 1;\nselect 2;\n\nselect 3";
    expect(statementAt(sql, 3)).toBe("select 1;");
    expect(statementAt(sql, sql.indexOf("select 2") + 2)).toBe("select 2;");
    expect(statementAt(sql, sql.length)).toBe("select 3");
    expect(statementAt("select 1;\n\n", 10)).toBe("select 1;");
    expect(statementAt("   ", 0)).toBe("");
  });

  it("判断读语句（写语句运行前要确认）", () => {
    for (const s of ["select 1", "  WITH a AS (select 1) select * from a", "-- 注释\nshow tables", "/* x */ explain select 1", "(select 1)"]) expect(isReadSql(s), s).toBe(true);
    for (const s of ["update t set a=1", "delete from t", "drop table t", "-- x\ninsert into t values (1)"]) expect(isReadSql(s), s).toBe(false);
  });

  it("单元格文字；被截断 / 二进制的值不允许编辑", () => {
    expect(cellText(null)).toBe("NULL");
    expect(cellText(5)).toBe("5");
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(isLossy("abc…（共 20000 字符，已截断）")).toBe(true);
    expect(isLossy("<二进制 100 字节>")).toBe(true);
    expect(isLossy("普通文字")).toBe(false);
  });

  const cols = [{ name: "id", dataType: "int4" }, { name: "note", dataType: "text" }];
  const rows = [[1, 'he said "hi", ok'], [2, null], [3, "line1\nline2"]];

  it("导出 CSV：带 BOM，含逗号 / 引号 / 换行的值加引号，NULL 是空", () => {
    const csv = toCsv(cols, rows);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toBe('\uFEFFid,note\r\n1,"he said ""hi"", ok"\r\n2,\r\n3,"line1\nline2"\r\n');
  });

  it("导出 JSON：NULL 保持为 null", () => {
    expect(JSON.parse(toJson(cols, rows))).toEqual([{ id: 1, note: 'he said "hi", ok' }, { id: 2, note: null }, { id: 3, note: "line1\nline2" }]);
  });

  it("导出 INSERT：按方言加引号，字符串里的单引号转义，数字不加引号", () => {
    const sql = toInsertSql("mysql", "t", cols, [[1, "it's"], [2, null]]);
    expect(sql).toBe("INSERT INTO `t` (`id`, `note`) VALUES (1, 'it''s');\nINSERT INTO `t` (`id`, `note`) VALUES (2, NULL);\n");
  });
});
