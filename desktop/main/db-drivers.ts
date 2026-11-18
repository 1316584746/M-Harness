import mysql from "mysql2/promise";
import pg from "pg";
import Cursor from "pg-cursor";
import type { DbColumn, DbDialect } from "../shared/db";

/**
 * 真正连数据库的驱动。每个驱动一条连接，两层只读保护（SQL 检查在上一层）：
 *  - 连接一建好就设成只读会话；
 *  - 每次查询都包在「只读事务」里，结束一律回滚。
 * 结果在这里就按行数上限截断，不会把大表整个读进内存。
 */

export interface DriverConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  tls: boolean;
  connectTimeoutMs: number;
}

export interface DriverQueryOpts {
  maxRows: number;
  timeoutMs: number;
  /** PostgreSQL 的 search_path / MySQL 的当前库之外，额外要切到的 schema */
  schema?: string;
  params?: unknown[];
  /** 写语句：用可写事务，成功后提交；默认只读事务，结束回滚 */
  write?: boolean;
}

export interface DriverResult {
  columns: DbColumn[];
  rows: unknown[][];
  truncated: boolean;
  /** 写语句影响的行数 */
  affectedRows?: number;
}

export interface DriverStmt {
  sql: string;
  params: unknown[];
  /** 这条语句应该刚好影响几行；不符就回滚整批 */
  expect?: number;
}

export interface DbDriver {
  readonly dialect: DbDialect;
  query(sql: string, o: DriverQueryOpts): Promise<DriverResult>;
  /** 一批写语句放在一个可写事务里：全部成功才提交，任何一条出错或行数不对就整批回滚。返回每条影响的行数 */
  exec?(stmts: DriverStmt[], o: { timeoutMs: number; schema?: string }): Promise<number[]>;
  alive(): boolean;
  version(): Promise<string>;
  close(): Promise<void>;
}

export type DriverFactory = (dialect: DbDialect, cfg: DriverConfig) => Promise<DbDriver>;

const q = (id: string) => '"' + id.replace(/"/g, '""') + '"';

// ───────── 把值变成能放进 JSON 的样子 ─────────

const CELL_MAX = 10_000;

export function cell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length > CELL_MAX ? v.slice(0, CELL_MAX) + `…（共 ${v.length} 字符，已截断）` : v;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v)) return v.length <= 64 ? "0x" + v.toString("hex") : `<二进制 ${v.length} 字节>`;
  if (v instanceof Uint8Array) return `<二进制 ${v.length} 字节>`;
  try {
    const s = JSON.stringify(v);
    return s.length > CELL_MAX ? s.slice(0, CELL_MAX) + "…" : s;
  } catch {
    return String(v);
  }
}

// ───────── PostgreSQL ─────────

const PG_TYPES: Record<number, string> = {
  16: "bool", 17: "bytea", 18: "char", 19: "name", 20: "int8", 21: "int2", 23: "int4", 25: "text", 26: "oid", 114: "json", 142: "xml", 700: "float4", 701: "float8",
  1042: "bpchar", 1043: "varchar", 1082: "date", 1083: "time", 1114: "timestamp", 1184: "timestamptz", 1186: "interval", 1266: "timetz", 1700: "numeric", 2950: "uuid", 3802: "jsonb",
};
// 日期、大整数、高精度小数保持原字符串，避免时区换算和精度丢失
const PG_RAW = new Set([20, 1082, 1083, 1114, 1184, 1266, 1700, 1186, 1182, 1115, 1185, 1231, 1016]);

async function pgDriver(cfg: DriverConfig): Promise<DbDriver> {
  const types = { getTypeParser: (oid: number, fmt?: "text" | "binary") => (PG_RAW.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, fmt as "text")) };
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || "postgres",
    ssl: cfg.tls ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: cfg.connectTimeoutMs,
    application_name: "M-Harness",
    options: "-c default_transaction_read_only=on",
    types: types as never,
  });
  let dead = false;
  client.on("error", () => (dead = true));
  client.on("end", () => (dead = true));
  await client.connect();
  await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const typeNames = new Map<number, string>(Object.entries(PG_TYPES).map(([k, v]) => [Number(k), v]));

  const nameTypes = async (oids: number[]) => {
    const missing = [...new Set(oids)].filter(o => !typeNames.has(o));
    if (!missing.length) return;
    try {
      const r = await client.query("SELECT oid::int AS oid, typname FROM pg_type WHERE oid = ANY($1::oid[])", [missing]);
      for (const row of r.rows) typeNames.set(row.oid, row.typname);
    } catch {
      /* 取不到类型名就用编号 */
    }
  };

  return {
    dialect: "postgresql",
    alive: () => !dead,
    async version() {
      const r = await client.query("SHOW server_version");
      return String(r.rows[0]?.server_version ?? "");
    },
    async query(sql, o) {
      await client.query(o.write ? "BEGIN READ WRITE" : "BEGIN READ ONLY");
      try {
        await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(o.timeoutMs))}`);
        if (o.schema) await client.query(`SET LOCAL search_path TO ${q(o.schema)}`);
        const cursor = client.query(new Cursor(sql, o.params ?? [], { rowMode: "array", types: types as never }));
        let rows: unknown[][];
        try {
          rows = (await cursor.read(o.maxRows + 1)) as unknown[][];
        } finally {
          await new Promise<void>(res => cursor.close(() => res()));
        }
        const fields = (cursor as unknown as { _result?: { fields?: Array<{ name: string; dataTypeID: number }> } })._result?.fields ?? [];
        await nameTypes(fields.map(f => f.dataTypeID));
        const truncated = rows.length > o.maxRows;
        if (o.write) await client.query("COMMIT");
        const affected = (cursor as unknown as { _result?: { rowCount?: number | null } })._result?.rowCount;
        return {
          affectedRows: o.write && typeof affected === "number" ? affected : undefined,
          columns: fields.map(f => ({ name: f.name, dataType: typeNames.get(f.dataTypeID) ?? `oid:${f.dataTypeID}` })),
          rows: (truncated ? rows.slice(0, o.maxRows) : rows).map(r => r.map(cell)),
          truncated,
        };
      } finally {
        await client.query("ROLLBACK").catch(() => {});
      }
    },
    async exec(stmts, o) {
      await client.query("BEGIN READ WRITE");
      try {
        await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(o.timeoutMs))}`);
        if (o.schema) await client.query(`SET LOCAL search_path TO ${q(o.schema)}`);
        const affected: number[] = [];
        for (const [i, s] of stmts.entries()) {
          const r = await client.query(s.sql, s.params as unknown[]);
          const n = r.rowCount ?? 0;
          if (s.expect !== undefined && n !== s.expect) throw new Error(`第 ${i + 1} 条影响了 ${n} 行（应该是 ${s.expect} 行），已全部撤销。数据可能已被别人改动，刷新后再试`);
          affected.push(n);
        }
        await client.query("COMMIT");
        return affected;
      } finally {
        await client.query("ROLLBACK").catch(() => {});
      }
    },
    async close() {
      dead = true;
      await client.end().catch(() => {});
    },
  };
}

// ───────── MySQL / MariaDB ─────────

const MY_TYPES: Record<number, string> = {};
for (const [name, code] of Object.entries((mysql as unknown as { Types?: Record<string, number> }).Types ?? {})) if (typeof code === "number") MY_TYPES[code] = name.toLowerCase();

async function mysqlDriver(cfg: DriverConfig): Promise<DbDriver> {
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database || undefined,
    ssl: cfg.tls ? { rejectUnauthorized: false } : undefined,
    connectTimeout: cfg.connectTimeoutMs,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    charset: "utf8mb4",
  });
  let dead = false;
  conn.on("error", () => (dead = true));
  (conn as unknown as { connection: import("node:events").EventEmitter }).connection.on("close", () => (dead = true));
  await conn.query("SET SESSION TRANSACTION READ ONLY");

  return {
    dialect: "mysql",
    alive: () => !dead,
    async version() {
      const [rows] = await conn.query({ sql: "SELECT VERSION() AS v", rowsAsArray: true });
      return String((rows as unknown[][])[0]?.[0] ?? "");
    },
    async query(sql, o) {
      const ms = Math.max(100, Math.floor(o.timeoutMs));
      // MySQL 用 MAX_EXECUTION_TIME（毫秒），MariaDB 用 max_statement_time（秒）；哪个认就用哪个
      await conn.query(`SET SESSION MAX_EXECUTION_TIME=${ms}`).catch(() => conn.query(`SET SESSION max_statement_time=${ms / 1000}`).catch(() => {}));
      if (o.schema) await conn.query(`USE \`${o.schema.replace(/`/g, "``")}\``);
      // DDL 会隐式提交事务，之后按会话默认（只读）执行，所以写语句期间要把会话临时改成可写，用完立刻改回只读
      let destroyed = false;
      try {
        if (o.write) await conn.query("SET SESSION TRANSACTION READ WRITE");
        await conn.query(o.write ? "START TRANSACTION READ WRITE" : "START TRANSACTION READ ONLY");
        if (o.write) {
          // 写语句不返回大结果集，不用流式；DDL 在 MySQL 里会自动提交，这里的 COMMIT 对它无害
          const [res, fields] = (await conn.query({ sql, rowsAsArray: true, timeout: ms, values: o.params } as never)) as unknown as [unknown, Array<{ name: string; columnType?: number; type?: number }> | undefined];
          await conn.query("COMMIT");
          if (Array.isArray(res)) {
            const rows = (res as unknown[][]).slice(0, o.maxRows).map(r => r.map(cell));
            return { columns: (fields ?? []).map(f => ({ name: f.name, dataType: MY_TYPES[f.columnType ?? f.type ?? -1] ?? "unknown" })), rows, truncated: (res as unknown[]).length > o.maxRows };
          }
          return { columns: [], rows: [], truncated: false, affectedRows: Number((res as { affectedRows?: number }).affectedRows ?? 0) };
        }
        const raw = (conn as unknown as { connection: unknown }).connection as unknown as { query: (opts: object, vals?: unknown[]) => import("node:events").EventEmitter & { stream: () => NodeJS.ReadableStream & { destroy: () => void } }; destroy: () => void };
        const query = raw.query({ sql, rowsAsArray: true, timeout: ms }, o.params);
        const stream = query.stream();
        let fields: Array<{ name: string; columnType?: number; type?: number }> = [];
        const rows: unknown[][] = [];
        let truncated = false;
        await new Promise<void>((resolve, reject) => {
          stream.on("fields", (f: typeof fields) => (fields = f));
          stream.on("data", (r: unknown[]) => {
            if (rows.length >= o.maxRows) {
              // 超过上限：不再读了。服务端还在发，直接断开这条连接，下次再重连
              truncated = true;
              destroyed = true;
              dead = true;
              raw.destroy();
              resolve();
              return;
            }
            rows.push(r.map(cell));
          });
          stream.on("end", resolve);
          stream.on("error", reject);
        });
        return { columns: fields.map(f => ({ name: f.name, dataType: MY_TYPES[f.columnType ?? f.type ?? -1] ?? "unknown" })), rows, truncated };
      } finally {
        if (!destroyed) {
          await conn.query("ROLLBACK").catch(() => {});
          if (o.write) await conn.query("SET SESSION TRANSACTION READ ONLY").catch(() => {});
        }
      }
    },
    async exec(stmts, o) {
      const ms = Math.max(100, Math.floor(o.timeoutMs));
      await conn.query(`SET SESSION MAX_EXECUTION_TIME=${ms}`).catch(() => conn.query(`SET SESSION max_statement_time=${ms / 1000}`).catch(() => {}));
      if (o.schema) await conn.query(`USE \`${o.schema.replace(/`/g, "``")}\``);
      await conn.query("SET SESSION TRANSACTION READ WRITE");
      try {
        await conn.query("START TRANSACTION READ WRITE");
        const affected: number[] = [];
        for (const [i, s] of stmts.entries()) {
          const [res] = (await conn.query({ sql: s.sql, values: s.params, timeout: ms } as never)) as unknown as [{ affectedRows?: number }];
          const n = Number(res?.affectedRows ?? 0);
          if (s.expect !== undefined && n !== s.expect) throw new Error(`第 ${i + 1} 条影响了 ${n} 行（应该是 ${s.expect} 行），已全部撤销。数据可能已被别人改动，刷新后再试`);
          affected.push(n);
        }
        await conn.query("COMMIT");
        return affected;
      } finally {
        await conn.query("ROLLBACK").catch(() => {});
        await conn.query("SET SESSION TRANSACTION READ ONLY").catch(() => {});
      }
    },
    async close() {
      dead = true;
      await conn.end().catch(() => conn.destroy());
    },
  };
}

export const realDriver: DriverFactory = (dialect, cfg) => (dialect === "mysql" ? mysqlDriver(cfg) : pgDriver(cfg));
