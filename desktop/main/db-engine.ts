import fs from "node:fs";
import path from "node:path";
import type { Connection } from "../shared/connections";
import {
  DB_APPLY_MAX,
  DB_DEFAULT_MAX_ROWS,
  DB_DEFAULT_TIMEOUT_MS,
  DB_MAX_ROWS,
  DB_MAX_TIMEOUT_MS,
  DB_PAGE_MAX,
  classifySql,
  hostDbType,
  isWritableEnv,
  wouldWrite,
  isDialect,
  type DbApplyReq,
  type DbApplyResult,
  type DbConnOption,
  type DbDataReq,
  type DbDialect,
  type DbEventTrigger,
  type DbExtension,
  type DbQueryRequest,
  type DbSchemaInfo,
  type DbQueryResult,
  type DbScopeRef,
  type DbStructure,
  type DbTableInfo,
  type DbTableRef,
  type TableMeta,
  type TableMetaRequest,
} from "../shared/db";
import { realDriver, type DbDriver, type DriverConfig, type DriverFactory } from "./db-drivers";
import { buildCount, buildOps, buildSelect, type Stmt } from "./db-sql";

/**
 * 数据库引擎（只读）：按「设置 → 连接」里的数据库连接，替插件 / 界面执行查询、取表结构。
 * 每个（连接, 库）一条会话，按顺序排队执行，空闲 5 分钟自动断开。
 * 所有查询先过 classifySql，再进数据库的只读事务；每次执行写一行审计日志（不含结果内容）。
 */

export interface DbEngineDeps {
  /** 取连接和它的明文秘密（只在主进程里用） */
  connections: { get(id: string): { conn: Connection; secrets: Record<string, string> } | undefined; list(): Connection[] };
  driver?: DriverFactory;
  idleMs?: number;
  /** 审计日志文件；不给就不记 */
  auditFile?: string;
  connectTimeoutMs?: number;
}

interface Session {
  driver: DbDriver;
  timer?: ReturnType<typeof setTimeout>;
  tail: Promise<unknown>;
  /** 连接配置的指纹：配置改了就换会话 */
  sig: string;
}

const AUDIT_MAX = 1024 * 1024;

export class DbError extends Error {
  constructor(
    message: string,
    public code: "not_found" | "disabled" | "unsupported" | "readonly" | "bad_request" | "failed" | "timeout",
  ) {
    super(message);
  }
}

const clamp = (v: unknown, def: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : def);

export class DbEngine {
  private sessions = new Map<string, Session>();
  private opening = new Map<string, Promise<Session>>();

  constructor(private d: DbEngineDeps) {}

  // ───────── 对外 ─────────

  /** 数据库类的连接（给授权界面用） */
  options(): DbConnOption[] {
    return this.d.connections
      .list()
      .filter(c => c.kind === "database")
      .map(c => ({ id: c.id, name: c.name, env: c.env, machine: c.machine, dbType: c.fields.dbType ?? "", supported: isDialect(c.fields.dbType), writable: isWritableEnv(c.env) }));
  }

  async query(req: DbQueryRequest, who = ""): Promise<DbQueryResult> {
    const got = this.d.connections.get(req.connectionId);
    const writable = !!got && isWritableEnv(got.conn.env);
    const chk = classifySql(req.sql, writable);
    if (!chk.ok) {
      const why = !writable && wouldWrite(req.sql) ? `这个连接的环境是「${got?.conn.env ?? ""}」，只读；只有开发 / 测试环境的库可以写` : chk.reason;
      this.audit({ who, id: req.connectionId, sql: req.sql, ok: false, err: why });
      throw new DbError(`已拦截：${why}`, "readonly");
    }
    if (chk.kind === "write" && !writable) throw new DbError("已拦截：这个连接是只读的", "readonly"); // 防御：不会走到这里
    const sql = chk.sql as string;
    const t0 = Date.now();
    try {
      const timeoutMs = clamp(req.timeoutMs, DB_DEFAULT_TIMEOUT_MS, DB_MAX_TIMEOUT_MS);
      const maxRows = clamp(req.maxRows, DB_DEFAULT_MAX_ROWS, DB_MAX_ROWS);
      const r = await this.run(req.connectionId, req.database, who, async (drv, d) => ({ dialect: drv.dialect, ...(await drv.query(sql, { maxRows, timeoutMs, schema: this.schemaFor(d, req.schema), write: chk.kind === "write" })) }), timeoutMs);
      const out: DbQueryResult = { columns: r.columns, rows: r.rows, truncated: r.truncated, rowCount: r.rows.length, elapsedMs: Date.now() - t0, dbType: hostDbType(r.dialect) };
      if (r.affectedRows !== undefined) out.affectedRows = r.affectedRows;

      this.audit({ who, id: req.connectionId, sql, ok: true, write: chk.kind === "write" || undefined, rows: out.affectedRows ?? out.rowCount, ms: out.elapsedMs, truncated: r.truncated });
      return out;
    } catch (e) {
      this.audit({ who, id: req.connectionId, sql, ok: false, err: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
      throw e;
    }
  }

  async tableMetadata(req: TableMetaRequest, who = ""): Promise<TableMeta> {
    const table = typeof req.table === "string" ? req.table.trim() : "";
    if (!table) throw new DbError("缺少表名", "bad_request");
    const t0 = Date.now();
    try {
      const meta = await this.run(
        req.connectionId,
        req.database,
        who,
        async (drv, d) => {
          const timeoutMs = 10_000;
          if (drv.dialect === "mysql") {
            const schema = req.schema || req.database || d.fields.database;
            if (!schema) throw new DbError("MySQL 需要指定库名（database）", "bad_request");
            const r = await drv.query("SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", { maxRows: 2000, timeoutMs, params: [schema, table] });
            return r.rows;
          }
          const schema = req.schema || "public";
          const r = await drv.query("SELECT column_name, CASE WHEN data_type = 'USER-DEFINED' THEN udt_name ELSE data_type END, is_nullable, character_maximum_length, numeric_precision, numeric_scale, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", { maxRows: 2000, timeoutMs, params: [schema, table] });
          return r.rows;
        },
        10_000,
      );
      if (!meta.length) throw new DbError(`找不到表 ${table}（或者这个账号看不到它）`, "not_found");
      const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
      const out: TableMeta = {
        columns: meta.map(r => ({
          name: String(r[0]),
          dataType: String(r[1]).toLowerCase(),
          nullable: String(r[2]).toUpperCase() === "YES",
          length: num(r[3]),
          precision: num(r[4]),
          scale: num(r[5]),
          default: r[6] === null || r[6] === undefined ? null : String(r[6]),
        })),
        fieldCapabilities: { length: "supported", precision: "supported", scale: "supported", default: "supported" },
      };
      this.audit({ who, id: req.connectionId, sql: `-- 表结构 ${table}`, ok: true, rows: out.columns.length, ms: Date.now() - t0 });
      return out;
    } catch (e) {
      this.audit({ who, id: req.connectionId, sql: `-- 表结构 ${table}`, ok: false, err: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
      throw e;
    }
  }

  // ───────── 工作台（界面里的「数据库」页）用 ─────────

  /** 取连接并检查它能不能用；返回方言 */
  private lookup(id: string): { got: { conn: Connection; secrets: Record<string, string> }; dialect: DbDialect } {
    const got = this.d.connections.get(id);
    if (!got) throw new DbError("这个连接不存在", "not_found");
    if (got.conn.kind !== "database") throw new DbError("这不是数据库连接", "bad_request");
    if (!got.conn.enabled) throw new DbError("这个连接已停用", "disabled");
    const dialect = got.conn.fields.dbType;
    if (!isDialect(dialect)) throw new DbError(`暂不支持 ${dialect} 类型的数据库（目前只有 MySQL 和 PostgreSQL）`, "unsupported");
    return { got, dialect };
  }

  /** 把界面传来的 database / schema 变成「哪个会话、哪个 schema」：MySQL 的库就是 schema，会话不用换；PostgreSQL 的库要换会话，schema 默认 public */
  private place(dialect: DbDialect, got: { conn: Connection }, ref: { database?: string; schema?: string }): { session?: string; schema?: string } {
    if (dialect === "mysql") return { schema: ref.schema || ref.database || got.conn.fields.database || undefined };
    return { session: ref.database || undefined, schema: ref.schema || "public" };
  }

  /** 查元数据：直接走驱动（只读事务），不经过用户 SQL 的检查 */
  private async meta(id: string, session: string | undefined, sql: string, params: unknown[], who: string): Promise<unknown[][]> {
    const t0 = Date.now();
    try {
      const r = await this.run(id, session, who, drv => drv.query(sql, { maxRows: DB_MAX_ROWS, timeoutMs: 15_000, params }), 15_000);
      this.audit({ who, id, sql: `-- ${sql.replace(/\s+/g, " ").slice(0, 120)}`, ok: true, rows: r.rows.length, ms: Date.now() - t0 });
      return r.rows;
    } catch (e) {
      this.audit({ who, id, sql: `-- ${sql.replace(/\s+/g, " ").slice(0, 120)}`, ok: false, err: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
      throw e;
    }
  }

  async listDatabases(connectionId: string, who = "ui"): Promise<string[]> {
    const { dialect } = this.lookup(connectionId);
    const rows =
      dialect === "mysql"
        ? await this.meta(connectionId, undefined, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY SCHEMA_NAME", [], who)
        : await this.meta(connectionId, undefined, "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname", [], who);
    return rows.map(r => String(r[0]));
  }

  /** PostgreSQL 的 schema 列表（MySQL 没有这一层，返回空） */
  async listSchemas(req: DbScopeRef, who = "ui"): Promise<DbSchemaInfo[]> {
    const { dialect, got } = this.lookup(req.connectionId);
    if (dialect === "mysql") return [];
    const rows = await this.meta(req.connectionId, this.place(dialect, got, req).session, "SELECT nspname, obj_description(oid, 'pg_namespace') FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' AND has_schema_privilege(nspname, 'USAGE') ORDER BY nspname", [], who);
    return rows.map(r => ({ name: String(r[0]), comment: r[1] ? String(r[1]) : undefined }));
  }

  /** PostgreSQL 已装的扩展（MySQL 没有，返回空） */
  async listExtensions(req: DbScopeRef, who = "ui"): Promise<DbExtension[]> {
    const { dialect, got } = this.lookup(req.connectionId);
    if (dialect === "mysql") return [];
    const rows = await this.meta(req.connectionId, this.place(dialect, got, req).session, "SELECT e.extname, e.extversion, obj_description(e.oid, 'pg_extension') FROM pg_extension e ORDER BY e.extname", [], who);
    return rows.map(r => ({ name: String(r[0]), version: String(r[1]), comment: r[2] ? String(r[2]) : undefined }));
  }

  /** PostgreSQL 的事件触发器（MySQL 没有，返回空） */
  async listEventTriggers(req: DbScopeRef, who = "ui"): Promise<DbEventTrigger[]> {
    const { dialect, got } = this.lookup(req.connectionId);
    if (dialect === "mysql") return [];
    const rows = await this.meta(req.connectionId, this.place(dialect, got, req).session, "SELECT evtname, evtevent, evtenabled <> 'D' FROM pg_event_trigger ORDER BY evtname", [], who);
    return rows.map(r => ({ name: String(r[0]), event: String(r[1]), enabled: r[2] === true || r[2] === "t" }));
  }

  async listTables(req: DbScopeRef, who = "ui"): Promise<DbTableInfo[]> {
    const { dialect, got } = this.lookup(req.connectionId);
    const at = this.place(dialect, got, req);
    if (!at.schema) throw new DbError("没有指定库", "bad_request");
    const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
    if (dialect === "mysql") {
      const rows = await this.meta(req.connectionId, at.session, "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", [at.schema], who);
      return rows.map(r => ({ name: String(r[0]), kind: /VIEW/i.test(String(r[1])) ? "view" : "table", rows: num(r[2]), comment: r[3] ? String(r[3]) : undefined }));
    }
    const rows = await this.meta(
      req.connectionId,
      at.session,
      "SELECT c.relname, c.relkind, c.reltuples::bigint, obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition ORDER BY c.relname",
      [at.schema],
      who,
    );
    return rows.map(r => ({ name: String(r[0]), kind: r[1] === "v" || r[1] === "m" ? "view" : "table", rows: num(r[2]), comment: r[3] ? String(r[3]) : undefined }));
  }

  async structure(req: DbTableRef, who = "ui"): Promise<DbStructure> {
    const table = typeof req.table === "string" ? req.table : "";
    if (!table) throw new DbError("缺少表名", "bad_request");
    const { dialect, got } = this.lookup(req.connectionId);
    const at = this.place(dialect, got, req);
    if (!at.schema) throw new DbError("没有指定库", "bad_request");
    const yes = (v: unknown) => v === true || v === 1 || v === "1" || v === "t" || String(v).toUpperCase() === "YES";
    let cols: unknown[][];
    let idx: unknown[][];
    let view: boolean;
    if (dialect === "mysql") {
      const p = [at.schema, table];
      cols = await this.meta(req.connectionId, at.session, "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT, COLUMN_KEY, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", p, who);
      idx = await this.meta(
        req.connectionId,
        at.session,
        "SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '), INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME",
        p,
        who,
      );
      const t = await this.meta(req.connectionId, at.session, "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", p, who);
      view = /VIEW/i.test(String(t[0]?.[0] ?? ""));
      if (!cols.length) throw new DbError(`找不到表 ${table}（或者这个账号看不到它）`, "not_found");
      return {
        view,
        columns: cols.map(r => ({ name: String(r[0]), dataType: String(r[1]), nullable: yes(r[2]), default: r[3] === null || r[3] === undefined ? null : String(r[3]), comment: r[4] ? String(r[4]) : "", pk: String(r[5]) === "PRI", extra: r[6] ? String(r[6]) : undefined })),
        indexes: idx.map(r => ({ name: String(r[0]), columns: String(r[2] ?? ""), unique: !Number(r[1]), primary: String(r[0]) === "PRIMARY", method: String(r[3] ?? "") })),
      };
    }
    const p = [at.schema, table];
    const rel = "to_regclass(quote_ident($1) || '.' || quote_ident($2))";
    cols = await this.meta(
      req.connectionId,
      at.session,
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum), EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = ${rel} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      p,
      who,
    );
    idx = await this.meta(
      req.connectionId,
      at.session,
      `SELECT i.relname, ix.indisunique, ix.indisprimary, array_to_string(ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true) FROM generate_subscripts(ix.indkey, 1) k ORDER BY k), ', '), am.amname FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_am am ON am.oid = i.relam WHERE ix.indrelid = ${rel} ORDER BY ix.indisprimary DESC, i.relname`,
      p,
      who,
    );
    const t = await this.meta(req.connectionId, at.session, `SELECT relkind IN ('v','m') FROM pg_class WHERE oid = ${rel}`, p, who);
    if (!cols.length) throw new DbError(`找不到表 ${table}（或者这个账号看不到它）`, "not_found");
    return {
      view: yes(t[0]?.[0]),
      columns: cols.map(r => ({ name: String(r[0]), dataType: String(r[1]), nullable: yes(r[2]), default: r[3] === null || r[3] === undefined ? null : String(r[3]), comment: r[4] ? String(r[4]) : "", pk: yes(r[5]) })),
      indexes: idx.map(r => ({ name: String(r[0]), columns: String(r[3] ?? ""), unique: yes(r[1]), primary: yes(r[2]), method: String(r[4] ?? "") })),
    };
  }

  /** 看一页表数据：拼成 SELECT 后和用户在 SQL 里写的查询走同一条检查 */
  async tableData(req: DbDataReq, who = "ui"): Promise<DbQueryResult> {
    if (!req.table) throw new DbError("缺少表名", "bad_request");
    const { dialect, got } = this.lookup(req.connectionId);
    const at = this.place(dialect, got, req);
    const limit = clamp(req.limit, 200, DB_PAGE_MAX);
    const sql = buildSelect(dialect, at.schema, req.table, { where: req.where, orderBy: req.orderBy, limit, offset: req.offset });
    return this.query({ connectionId: req.connectionId, database: at.session, sql, maxRows: limit, timeoutMs: 20_000 }, who);
  }

  /** 精确行数（大表可能慢，所以只在用户点的时候算） */
  async tableCount(req: DbDataReq, who = "ui"): Promise<number> {
    if (!req.table) throw new DbError("缺少表名", "bad_request");
    const { dialect, got } = this.lookup(req.connectionId);
    const at = this.place(dialect, got, req);
    const r = await this.query({ connectionId: req.connectionId, database: at.session, sql: buildCount(dialect, at.schema, req.table, req.where), maxRows: 1, timeoutMs: 30_000 }, who);
    return Number(r.rows[0]?.[0] ?? 0);
  }

  /** 提交行修改（新增 / 修改 / 删除）：只有开发 / 测试环境的库能写；一批在一个事务里，出错整批回滚 */
  async applyRows(req: DbApplyReq, who = "ui"): Promise<DbApplyResult> {
    if (!req.table) throw new DbError("缺少表名", "bad_request");
    if (!Array.isArray(req.ops) || !req.ops.length) throw new DbError("没有要提交的修改", "bad_request");
    if (req.ops.length > DB_APPLY_MAX) throw new DbError(`一次最多提交 ${DB_APPLY_MAX} 条修改`, "bad_request");
    const { dialect, got } = this.lookup(req.connectionId);
    const label = `-- 修改 ${req.table}`;
    if (!isWritableEnv(got.conn.env)) {
      const why = `这个连接的环境是「${got.conn.env}」，只读；只有开发 / 测试环境的库可以改数据`;
      this.audit({ who, id: req.connectionId, sql: label, ok: false, err: why });
      throw new DbError(`已拦截：${why}`, "readonly");
    }
    const okVal = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    for (const op of req.ops) for (const part of [(op as { values?: Record<string, unknown> }).values, (op as { key?: Record<string, unknown> }).key]) for (const v of Object.values(part ?? {})) if (!okVal(v)) throw new DbError("值只能是文本、数字、布尔或空", "bad_request");
    const at = this.place(dialect, got, req);
    let stmts: Stmt[];
    try {
      stmts = buildOps(dialect, at.schema, req.table, req.ops);
    } catch (e) {
      throw new DbError(e instanceof Error ? e.message : String(e), "bad_request");
    }
    const sqlText = stmts.map(s => s.sql).join("; ");
    const t0 = Date.now();
    try {
      const affected = await this.run(
        req.connectionId,
        at.session,
        who,
        async drv => {
          if (!drv.exec) throw new DbError("这种数据库驱动不支持批量修改", "unsupported");
          return drv.exec(stmts, { timeoutMs: 30_000 });
        },
        30_000,
      );
      this.audit({ who, id: req.connectionId, sql: sqlText, ok: true, write: true, rows: affected.reduce((a, b) => a + b, 0), ms: Date.now() - t0 });
      return { affected };
    } catch (e) {
      this.audit({ who, id: req.connectionId, sql: sqlText, ok: false, write: true, err: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
      throw e;
    }
  }

  /** 登录一次看看（给「测试连接」用）：返回数据库版本 */
  async probe(conn: Connection, secrets: Record<string, string>): Promise<string> {
    const dialect = conn.fields.dbType;
    if (!isDialect(dialect)) throw new DbError(`暂不支持 ${dialect}`, "unsupported");
    let drv: DbDriver;
    try {
      drv = await (this.d.driver ?? realDriver)(dialect, this.config(conn, secrets));
    } catch (e) {
      throw new DbError(this.friendly(e), "failed");
    }
    try {
      return await drv.version();
    } finally {
      await drv.close();
    }
  }

  /** 连接改了 / 删了：断开它的所有会话 */
  async closeConnection(id: string): Promise<void> {
    const keys = [...this.sessions.keys()].filter(k => k.split("\n")[0] === id);
    await Promise.all(keys.map(k => this.drop(k)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(k => this.drop(k)));
  }

  // ───────── 内部 ─────────

  private schemaFor(d: Connection, schema?: string): string | undefined {
    // MySQL 的「库」就是 schema，由连接时指定的库决定，这里只处理 PostgreSQL 的 search_path
    return d.fields.dbType === "postgresql" && schema ? schema : undefined;
  }

  private config(conn: Connection, secrets: Record<string, string>, database?: string): DriverConfig {
    return {
      host: conn.fields.host.trim(),
      port: Number(conn.fields.port) || (conn.fields.dbType === "mysql" ? 3306 : 5432),
      user: conn.fields.username ?? "",
      password: secrets.password ?? "",
      database: (database || conn.fields.database || "").trim() || undefined,
      tls: conn.fields.tls === "true",
      connectTimeoutMs: this.d.connectTimeoutMs ?? 8000,
    };
  }

  private async run<T>(id: string, database: string | undefined, who: string, fn: (drv: DbDriver, conn: Connection) => Promise<T>, timeoutMs: number): Promise<T> {
    const got = this.d.connections.get(id);
    if (!got) throw new DbError("这个连接不存在", "not_found");
    if (got.conn.kind !== "database") throw new DbError("这不是数据库连接", "bad_request");
    if (!got.conn.enabled) throw new DbError("这个连接已停用", "disabled");
    if (!isDialect(got.conn.fields.dbType)) throw new DbError(`暂不支持 ${got.conn.fields.dbType} 类型的数据库（目前只有 MySQL 和 PostgreSQL）`, "unsupported");
    const key = `${id}\n${database ?? ""}`;
    const s = await this.session(key, got.conn, got.secrets, database);
    // 同一条会话上的请求排队，前一个失败不影响后面的
    const job = s.tail.catch(() => {}).then(() => this.guarded(key, s, timeoutMs, () => fn(s.driver, got.conn)));
    s.tail = job.catch(() => {});
    this.touch(key, s);
    return job;
  }

  /** 超时就把会话断掉（数据库那边的语句会随连接断开而取消） */
  private async guarded<T>(key: string, s: Session, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        void this.drop(key);
        rej(new DbError(`查询超过 ${Math.round(timeoutMs / 1000)} 秒，已取消`, "timeout"));
      }, timeoutMs + 2000);
    });
    try {
      return await Promise.race([fn(), timeout]);
    } catch (e) {
      if (e instanceof DbError) throw e;
      if (!s.driver.alive()) void this.drop(key);
      throw new DbError(e instanceof Error ? e.message : String(e), "failed");
    } finally {
      clearTimeout(timer);
    }
  }

  private async session(key: string, conn: Connection, secrets: Record<string, string>, database?: string): Promise<Session> {
    const sig = JSON.stringify([conn.fields, secrets.password ?? "", conn.updatedAt]);
    const cur = this.sessions.get(key);
    if (cur && cur.sig === sig && cur.driver.alive()) return cur;
    if (cur) await this.drop(key);
    const going = this.opening.get(key);
    if (going) return going;
    const p = (async () => {
      let driver: DbDriver;
      try {
        driver = await (this.d.driver ?? realDriver)(conn.fields.dbType as DbDialect, this.config(conn, secrets, database));
      } catch (e) {
        throw new DbError(this.friendly(e), "failed");
      }
      const s: Session = { driver, tail: Promise.resolve(), sig };
      this.sessions.set(key, s);
      return s;
    })().finally(() => this.opening.delete(key));
    this.opening.set(key, p);
    return p;
  }

  private friendly(e: unknown): string {
    const m = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string })?.code;
    if (code === "ECONNREFUSED") return "连接被拒绝（端口没有服务在监听，或被防火墙拦了）";
    if (code === "ENOTFOUND") return "找不到这个主机，请检查地址";
    if (code === "ETIMEDOUT" || /timeout/i.test(m)) return "连接超时，请检查地址、端口和网络";
    if (code === "ER_ACCESS_DENIED_ERROR" || code === "28P01" || /password authentication failed|Access denied/i.test(m)) return "用户名或密码不对";
    return `连接失败：${m}`;
  }

  private touch(key: string, s: Session): void {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void this.drop(key), this.d.idleMs ?? 5 * 60_000);
    s.timer.unref?.();
  }

  private async drop(key: string): Promise<void> {
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    clearTimeout(s.timer);
    await s.driver.close().catch(() => {});
  }

  private audit(e: { who: string; id: string; sql: string; ok: boolean; write?: boolean; rows?: number; ms?: number; truncated?: boolean; err?: string }): void {
    const f = this.d.auditFile;
    if (!f) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (fs.existsSync(f) && fs.statSync(f).size > AUDIT_MAX) fs.renameSync(f, f + ".1");
      fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), who: e.who, conn: e.id, sql: e.sql.slice(0, 500), ok: e.ok, write: e.write, rows: e.rows, ms: e.ms, truncated: e.truncated || undefined, err: e.err }) + "\n");
    } catch {
      /* 审计写不进去不影响查询 */
    }
  }
}
