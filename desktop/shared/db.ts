/**
 * 数据库访问（只读）：类型 + SQL 只读检查。
 * 这一版只开放查询，不开放任何写入：先用下面的 classifySql 在发出去之前拦一道，
 * 数据库那边再用「只读事务」兜底（见 main/db-drivers.ts），两道都过才会执行。
 */

export type DbDialect = "mysql" | "postgresql";

export const DB_DIALECTS: DbDialect[] = ["mysql", "postgresql"];

export const isDialect = (v: string | undefined): v is DbDialect => v === "mysql" || v === "postgresql";

export interface DbColumn {
  name: string;
  dataType: string;
}

export interface DbQueryRequest {
  connectionId: string;
  sql: string;
  database?: string;
  schema?: string;
  maxRows?: number;
  timeoutMs?: number;
}

export interface DbQueryResult {
  columns: DbColumn[];
  rows: unknown[][];
  /** 行数超过上限被截断 */
  truncated: boolean;
  rowCount: number;
  elapsedMs: number;
  /** 写语句影响的行数（读语句没有） */
  affectedRows?: number;
  /** 给插件看的库类型：mysql / postgres（和 DBX 的叫法一致） */
  dbType: string;
}

/** 本软件的方言名 → 插件协议里的库类型名 */
export const hostDbType = (d: string): string => (d === 'postgresql' ? 'postgres' : d);

export interface TableMetaRequest {
  connectionId: string;
  database?: string;
  schema?: string;
  table: string;
}

export type FieldAvailability = "supported" | "unsupported" | "unknown";

export interface TableMeta {
  columns: Array<{ name: string; dataType: string; nullable: boolean; length?: number | null; precision?: number | null; scale?: number | null; default?: string | null }>;
  fieldCapabilities: { length: FieldAvailability; precision: FieldAvailability; scale: FieldAvailability; default: FieldAvailability };
}

/** 给界面选择授权用的一条数据库连接 */
export interface DbConnOption {
  id: string;
  name: string;
  env: string;
  machine: string;
  dbType: string;
  /** 本软件现在能不能查（目前只有 MySQL / PostgreSQL） */
  supported: boolean;
  /** 允许写（开发 / 测试环境）；否则只读 */
  writable: boolean;
}

export const DB_DEFAULT_MAX_ROWS = 1000;
export const DB_MAX_ROWS = 5000;
export const DB_DEFAULT_TIMEOUT_MS = 15_000;
export const DB_MAX_TIMEOUT_MS = 60_000;

export interface SqlCheck {
  ok: boolean;
  /** 不通过的原因（给用户看） */
  reason?: string;
  /** 通过时：去掉结尾分号后的语句 */
  sql?: string;
  /** 通过时：读还是写 */
  kind?: "read" | "write";
}

// ───────── SQL 只读检查 ─────────

/** 把注释去掉、字符串和带引号的标识符内容抹成空格；遇到不能放行的写法直接报原因 */
function strip(sql: string): { text: string } | { error: string } {
  let out = "";
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "-" && d === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "#") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && d === "*") {
      const e = sql.indexOf("*/", i + 2);
      const body = sql.slice(i + 2, e < 0 ? n : e);
      // MySQL 的 /*! ... */ 里的内容会被当成语句执行，不能当注释放过
      if (body.startsWith("!") || body.startsWith("M!")) return { error: "不允许使用 /*! ... */ 这种会被执行的注释" };
      if (e < 0) return { error: "注释没有结束" };
      i = e + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      // 字符串 / 标识符：MySQL 里反斜杠可以转义，PostgreSQL 的 E'..' 也是；按转义处理更保守
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "\\" && c !== "`") j += 2;
        else if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else {
            closed = true;
            break;
          }
        } else j++;
      }
      if (!closed) return { error: "引号没有闭合" };
      out += c + " ".repeat(Math.max(0, j - i - 1)) + c;
      i = j + 1;
    } else if (c === "$") {
      // PostgreSQL 的 $tag$ ... $tag$
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        if (e < 0) return { error: "$$ 引用没有闭合" };
        out += " ".repeat(e + m[0].length - i);
        i = e + m[0].length;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return { text: out };
}

const FIRST_OK = new Set(["select", "with", "show", "describe", "desc", "explain", "values", "table"]);

// 单条 SELECT / WITH 语句里还能写数据或锁数据的写法：数据修改型 CTE、SELECT INTO、INTO OUTFILE、FOR UPDATE / SHARE 等。
// 只放最没有歧义的词，免得把叫 comment / start / release 的普通列名也拦掉；其余靠数据库那边的只读事务兜底。
const FORBIDDEN = /\b(insert|update|delete|merge|into|truncate|drop|alter|create|grant|revoke)\b|\breplace\b(?!\s*\()|\block\s+in\s+share\b|\bfor\s+(share|key\s+share|no\s+key\s+update)\b/i;

// 读文件、改状态、起外部命令的函数
const FORBIDDEN_FN =
  /\b(pg_read_file|pg_read_binary_file|pg_ls_\w*|pg_stat_file|lo_\w+|pg_terminate_backend|pg_cancel_backend|set_config|pg_reload_conf|pg_rotate_logfile|pg_create_\w+|pg_drop_\w+|pg_promote|pg_switch_\w+|pg_advisory_\w+|nextval|setval|dblink\w*|load_file|get_lock|release_lock|benchmark|sys_exec|sys_eval|xp_cmdshell|query_to_xml\w*|pg_sleep\w*|sleep)\s*\(/i;

const WRITE_FIRST = new Set(["insert", "update", "delete", "replace", "merge", "create", "alter", "drop", "truncate", "rename", "select", "with"]);

// 写模式下仍然不放行的：改权限、起存储过程、读写服务器文件、建库建用户、扩展 / 外部表
const WRITE_FORBIDDEN =
  /\b(grant|revoke|outfile|dumpfile)\b|\b(drop|create|alter)\s+(or\s+replace\s+)?(database|schema|user|role|group|extension|server|tablespace|event|trigger|function|procedure|language|foreign|publication|subscription|system|resource|logfile|instance)\b|\bcreate\s+(or\s+replace\s+)?(definer\s*=\s*\S+\s+)?(function|procedure|trigger|event)\b/i;

/** 能写的环境：开发 / 测试；生产、线上、预发、其他自己起名的环境一律只读 */
export const isProdEnv = (env: string): boolean => /生产|线上|正式|prod|预发|灰度|pre-?release|staging|uat/i.test(env);
export const isWritableEnv = (env: string): boolean => !isProdEnv(env) && /开发|测试|本地|沙箱|dev|test|local|sandbox|qa/i.test(env);

interface Prepared {
  body: string;
  first: string;
  sql: string;
}

function prepare(raw: string): Prepared | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "SQL 是空的" };
  if (raw.length > 200_000) return { error: "SQL 太长（最多 20 万字符）" };
  if (raw.includes("\0")) return { error: "SQL 里有不合法字符" };
  const s = strip(raw);
  if ("error" in s) return { error: s.error };
  const text = s.text.trim();
  // 一条语句：允许结尾一个分号，中间不能有
  const semi = text.indexOf(";");
  if (semi >= 0 && text.slice(semi + 1).trim() !== "") return { error: "一次只能执行一条语句" };
  const body = (semi >= 0 ? text.slice(0, semi) : text).trim();
  if (!body) return { error: "SQL 是空的" };
  const first = /^[(\s]*([A-Za-z]+)/.exec(body)?.[1]?.toLowerCase() ?? "";
  // 去掉结尾分号，保留用户原来的写法（注释、字符串都原样）
  const cut = raw.lastIndexOf(";");
  const sql = cut >= 0 && raw.slice(cut + 1).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|\s/g, "") === "" ? raw.slice(0, cut) : raw;
  return { body, first, sql: sql.trim() };
}

function readCheck(p: Prepared): string | undefined {
  if (!p.first || !FIRST_OK.has(p.first)) return `只允许查询语句（SELECT / WITH / SHOW / DESCRIBE / EXPLAIN），不允许 ${p.first ? p.first.toUpperCase() : "这种写法"}`;
  const bad = FORBIDDEN.exec(p.body);
  if (bad) {
    const w = (bad[1] ?? bad[0]).trim().replace(/\s+/g, " ").toUpperCase();
    return w === "INTO" ? "不允许 SELECT ... INTO / INTO OUTFILE" : w === "UPDATE" ? "不允许 FOR UPDATE，也不允许 UPDATE" : `只读模式下查询里不能出现 ${w}`;
  }
  if (p.first === "explain" && /\banalyze\b/i.test(p.body)) return "不允许 EXPLAIN ANALYZE（它会真的执行语句）";
  const fn = FORBIDDEN_FN.exec(p.body);
  if (fn) return `不允许调用函数 ${fn[1]}`;
  return undefined;
}

function writeCheck(p: Prepared): string | undefined {
  if (!WRITE_FIRST.has(p.first)) return `不允许 ${p.first ? p.first.toUpperCase() : "这种写法"}（可写的只有 INSERT / UPDATE / DELETE / REPLACE / MERGE / CREATE / ALTER / DROP / TRUNCATE）`;
  const bad = WRITE_FORBIDDEN.exec(p.body);
  if (bad) return `不允许 ${bad[0].trim().replace(/\s+/g, " ").toUpperCase()}（改权限、建库建用户、存储过程、读写服务器文件等不开放）`;
  const fn = FORBIDDEN_FN.exec(p.body);
  // 序列函数在可写的库里无害
  if (fn && !/^(nextval|setval)$/i.test(fn[1])) return `不允许调用函数 ${fn[1]}`;
  return undefined;
}

/**
 * 只放行单条语句。
 *  - 默认只读：SELECT / WITH / SHOW / DESCRIBE / EXPLAIN（不带 ANALYZE）/ VALUES / TABLE。
 *  - allowWrite=true（开发 / 测试环境的库）：只读语句之外，还放行 INSERT / UPDATE / DELETE / DDL 等，
 *    但改权限、建库建用户、存储过程、读写服务器文件这些仍然拦。
 * 宁可错拦：拦错了用户改写一下，放错了就是改坏库。返回里的 kind 说明这条语句要不要写权限。
 */
export function classifySql(raw: string, allowWrite = false): SqlCheck {
  const p = prepare(raw);
  if ("error" in p) return { ok: false, reason: p.error };
  const readErr = readCheck(p);
  if (!readErr) return { ok: true, sql: p.sql, kind: "read" };
  if (!allowWrite) return { ok: false, reason: readErr };
  const writeErr = writeCheck(p);
  if (writeErr) return { ok: false, reason: FIRST_OK.has(p.first) && /^(不允许调用|不允许 EXPLAIN)/.test(readErr) ? readErr : writeErr };
  return { ok: true, sql: p.sql, kind: "write" };
}

/** 这条语句如果换成可写的环境能不能跑（用来给只读连接解释「为什么不行」） */
export const wouldWrite = (raw: string): boolean => {
  const c = classifySql(raw, true);
  return c.ok && c.kind === "write";
};
/** 标识符加引号（防注入：我们自己拼 search_path 之类的语句时用） */
export const quoteIdent = (dialect: DbDialect, name: string): string => (dialect === "mysql" ? "`" + name.replace(/`/g, "``") + "`" : '"' + name.replace(/"/g, '""') + '"');

// ───────── 数据库工作台（界面里的「数据库」页）用的类型 ─────────

/** 界面调用的结果：成功带数据，失败带原因（不让异常穿过进程边界） */
export type DbResp<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/** 定位一张表：PostgreSQL 的 database + schema；MySQL 的库名放 schema（或 database）里 */
export interface DbTableRef {
  connectionId: string;
  database?: string;
  schema?: string;
  table: string;
}

/** 定位一个库 / schema（列表用） */
export interface DbScopeRef {
  connectionId: string;
  database?: string;
  schema?: string;
}

export interface DbSchemaInfo {
  name: string;
  comment?: string;
}

/** PostgreSQL 已安装的扩展（只看） */
export interface DbExtension {
  name: string;
  version: string;
  comment?: string;
}

/** PostgreSQL 的事件触发器（只看） */
export interface DbEventTrigger {
  name: string;
  event: string;
  enabled: boolean;
}

export interface DbTableInfo {
  name: string;
  kind: "table" | "view";
  /** 估算行数（统计信息里的，不一定准）；取不到为空 */
  rows?: number | null;
  comment?: string;
}

export interface DbStructureColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  pk: boolean;
  comment: string;
  /** MySQL 的 auto_increment 之类 */
  extra?: string;
}

export interface DbStructureIndex {
  name: string;
  columns: string;
  unique: boolean;
  primary: boolean;
  method: string;
}

export interface DbStructure {
  columns: DbStructureColumn[];
  indexes: DbStructureIndex[];
  /** 是视图：不能改数据 */
  view: boolean;
}

/** 看表数据：WHERE / ORDER BY 是用户写的片段（不带关键字），整句仍要过只读检查 */
export interface DbDataReq extends DbTableRef {
  where?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

export type DbRowOp =
  | { kind: "insert"; values: Record<string, unknown> }
  | { kind: "update"; key: Record<string, unknown>; values: Record<string, unknown> }
  | { kind: "delete"; key: Record<string, unknown> };

/** 提交行修改：一批操作在一个事务里，任何一条失败整批回滚 */
export interface DbApplyReq extends DbTableRef {
  ops: DbRowOp[];
}

export interface DbApplyResult {
  /** 每条操作影响的行数 */
  affected: number[];
}

/** 工作台里表数据一次最多取多少行（界面一页最多 1000，导出全部时用满） */
export const DB_PAGE_MAX = 5000;
export const DB_APPLY_MAX = 500;

/** 数据库页当前选中的位置（给右边的 AI 助手当上下文）：连接 / 库 / schema / 打开的表 */
export interface DbFocus {
  connId: string;
  database?: string;
  schema?: string;
  table?: string;
}
