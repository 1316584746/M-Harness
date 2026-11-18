import type { DbDialect } from "../../../shared/db";
import { splitStatements, tokenize } from "./sqlText";

/**
 * SQL 编辑器的联想补齐：关键字、函数、数据类型、表 / 视图、字段、常用片段。
 * 纯函数，不碰界面：给它 SQL、光标位置和「当前库里有什么」，返回候选。
 * 会看光标前面的语境（FROM 后面先给表，WHERE / SELECT 后面先给字段），
 * `别名.` 或 `表名.` 后面给这张表的字段，`schema.` 后面给这个 schema 的表。
 */

export type CompKind = "snippet" | "keyword" | "function" | "type" | "table" | "view" | "column" | "schema";

export interface CompItem {
  label: string;
  /** 选中后写进编辑器的文字 */
  insert: string;
  kind: CompKind;
  /** 右边灰色的说明：function / data type / 字段类型 / 片段内容… */
  detail?: string;
  /** 写入后光标放在 insert 的第几个字符（默认放在最后） */
  cursor?: number;
  /** label 里被输入内容命中的位置，用来加粗 */
  hits: number[];
  score: number;
}

export interface CompColumn {
  name: string;
  dataType: string;
  pk?: boolean;
}
export interface CompTable {
  name: string;
  kind: "table" | "view";
}

export interface CompSource {
  dialect: DbDialect;
  /** 当前 schema（PostgreSQL）或库（MySQL），`表名` 不带前缀时就在这里找 */
  schema: string;
  tables: CompTable[];
  schemas: string[];
  /** 某张表的字段；还没取到时返回 undefined（调用方会去取，取到后再算一次） */
  columns(schema: string | undefined, table: string): CompColumn[] | undefined;
  /** 某个 schema 里的表；还没取到时返回 undefined */
  tablesIn(schema: string): CompTable[] | undefined;
}

export interface CompResult {
  /** 被替换的区间：[from, to) */
  from: number;
  to: number;
  items: CompItem[];
}

// ───────── 词表 ─────────

const KEYWORDS = (
  "SELECT FROM WHERE AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS ORDER BY GROUP HAVING LIMIT OFFSET JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL ON USING AS DISTINCT UNION ALL INTERSECT EXCEPT " +
  "INSERT INTO VALUES UPDATE SET DELETE CREATE ALTER DROP TRUNCATE TABLE INDEX VIEW DATABASE SCHEMA PRIMARY KEY FOREIGN REFERENCES UNIQUE DEFAULT CHECK CONSTRAINT ADD COLUMN RENAME TO IF " +
  "WITH RECURSIVE CASE WHEN THEN ELSE END ASC DESC TRUE FALSE RETURNING OVER PARTITION WINDOW FETCH NEXT ROWS ONLY FOR SHOW DESCRIBE EXPLAIN ANALYZE BEGIN COMMIT ROLLBACK USE " +
  "CASCADE RESTRICT TEMPORARY TEMP UNLOGGED REPLACE MATERIALIZED LATERAL FILTER NULLS FIRST LAST COLLATE CAST ANY SOME GRANT REVOKE VACUUM COMMENT"
).split(" ");

const FN_PG = (
  "COUNT SUM AVG MIN MAX COALESCE NULLIF GREATEST LEAST NOW CURRENT_DATE CURRENT_TIMESTAMP DATE_TRUNC DATE_PART EXTRACT TO_CHAR TO_DATE TO_TIMESTAMP TO_NUMBER AGE LOWER UPPER INITCAP LENGTH CHAR_LENGTH SUBSTRING SUBSTR TRIM LTRIM RTRIM BTRIM REPLACE CONCAT CONCAT_WS " +
  "SPLIT_PART POSITION STRPOS LEFT RIGHT LPAD RPAD REPEAT REVERSE REGEXP_REPLACE REGEXP_MATCHES REGEXP_SPLIT_TO_ARRAY STRING_AGG ARRAY_AGG JSON_AGG JSONB_AGG JSONB_ARRAY_ELEMENTS JSONB_ARRAY_ELEMENTS_TEXT JSONB_BUILD_OBJECT JSONB_BUILD_ARRAY JSON_BUILD_OBJECT " +
  "JSONB_EXTRACT_PATH_TEXT JSONB_SET JSONB_EACH JSONB_OBJECT_KEYS JSONB_PRETTY JSONB_TYPEOF ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTILE ROUND CEIL CEILING FLOOR TRUNC ABS MOD POWER SQRT RANDOM GENERATE_SERIES UNNEST ARRAY_LENGTH ARRAY_TO_STRING " +
  "STRING_TO_ARRAY MD5 GEN_RANDOM_UUID CAST JUSTIFY_INTERVAL JUSTIFY_DAYS PG_SIZE_PRETTY PG_TOTAL_RELATION_SIZE PG_RELATION_SIZE PG_DATABASE_SIZE CURRENT_SCHEMA CURRENT_USER CURRENT_DATABASE VERSION BOOL_AND BOOL_OR EVERY"
).split(" ");

const FN_MYSQL = (
  "COUNT SUM AVG MIN MAX IFNULL IF COALESCE NULLIF GREATEST LEAST NOW CURDATE CURTIME CURRENT_TIMESTAMP DATE_FORMAT DATE_ADD DATE_SUB DATEDIFF TIMESTAMPDIFF STR_TO_DATE UNIX_TIMESTAMP FROM_UNIXTIME YEAR MONTH DAY HOUR MINUTE SECOND DATE LOWER UPPER LENGTH CHAR_LENGTH SUBSTRING SUBSTR TRIM LTRIM RTRIM " +
  "REPLACE CONCAT CONCAT_WS LEFT RIGHT LPAD RPAD REPEAT REVERSE INSTR LOCATE GROUP_CONCAT JSON_EXTRACT JSON_OBJECT JSON_ARRAY JSON_UNQUOTE JSON_CONTAINS JSON_LENGTH ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE NTILE ROUND CEIL CEILING FLOOR TRUNCATE ABS MOD POW POWER SQRT RAND UUID MD5 SHA2 CAST CONVERT DATABASE VERSION"
).split(" ");

const TYPES_PG = "BIGINT BIGSERIAL BOOLEAN BYTEA CHAR CHARACTER VARYING DATE DECIMAL DOUBLE PRECISION INTEGER INT INTERVAL JSON JSONB NUMERIC REAL SERIAL SMALLINT SMALLSERIAL TEXT TIME TIMESTAMP TIMESTAMPTZ UUID VARCHAR".split(" ");
const TYPES_MYSQL = "BIGINT BINARY BIT BLOB BOOLEAN CHAR DATE DATETIME DECIMAL DOUBLE ENUM FLOAT INT INTEGER JSON LONGTEXT MEDIUMINT MEDIUMTEXT SMALLINT TEXT TIME TIMESTAMP TINYINT VARCHAR YEAR".split(" ");

const SNIPPETS: Array<{ trigger: string; label: string; detail: string; insert: string; cursor: number }> = [
  { trigger: "sel", label: "select *", detail: "SELECT * FROM table LIMIT 100;", insert: "SELECT * FROM  LIMIT 100;", cursor: 14 },
  { trigger: "selc", label: "select count(*)", detail: "SELECT COUNT(*) FROM table;", insert: "SELECT COUNT(*) FROM ;", cursor: 21 },
  { trigger: "ins", label: "insert into", detail: "INSERT INTO table () VALUES ();", insert: "INSERT INTO  () VALUES ();", cursor: 12 },
  { trigger: "upd", label: "update", detail: "UPDATE table SET col = val WHERE …;", insert: "UPDATE  SET  WHERE ;", cursor: 7 },
  { trigger: "del", label: "delete from", detail: "DELETE FROM table WHERE …;", insert: "DELETE FROM  WHERE ;", cursor: 12 },
  { trigger: "crt", label: "create table", detail: "CREATE TABLE name (id …);", insert: "CREATE TABLE  (\n  id bigint PRIMARY KEY\n);", cursor: 13 },
];

/** 不加引号会出错的名字（够用的一小部分） */
const RESERVED = new Set("select from where order group by user table index key column check default limit offset join left right inner outer on as and or not null in is like case when then else end union all distinct having insert into values update set delete create alter drop primary foreign references unique desc asc with true false to for grant only fetch window using".split(" "));

// ───────── 小工具 ─────────

const WORD = /[\w$]/;
const TABLE_CTX = new Set(["from", "join", "into", "update", "table", "truncate"]);
/** 不是别名的词（FROM a WHERE … 里的 WHERE） */
const NOT_ALIAS = new Set(["on", "where", "join", "left", "right", "inner", "outer", "full", "cross", "natural", "group", "order", "having", "limit", "offset", "union", "intersect", "except", "using", "set", "values", "returning", "select", "for", "window", "fetch", "lateral"]);

export const needsQuote = (dialect: DbDialect, name: string): boolean => (dialect === "postgresql" ? !/^[a-z_][a-z0-9_$]*$/.test(name) : !/^[A-Za-z_][\w$]*$/.test(name)) || RESERVED.has(name.toLowerCase());

const quoted = (dialect: DbDialect, name: string, q?: string): string => {
  const c = q ?? (dialect === "postgresql" ? '"' : "`");
  return c + name.split(c).join(c + c) + c;
};

const ident = (dialect: DbDialect, name: string, q?: string): string => (q || needsQuote(dialect, name) ? quoted(dialect, name, q) : name);

const unq = (s: string): string => (/^["`].*["`]$/.test(s) ? s.slice(1, -1).replace(/""|``/g, m => m[0]) : s);

/** 输入内容在 label 里的命中：前缀 > 子串 > 按顺序命中的字母（所以 sel 也能找到 SERIAL） */
function match(label: string, prefix: string): { score: number; hits: number[] } | null {
  if (!prefix) return { score: 0, hits: [] };
  const l = label.toLowerCase();
  const p = prefix.toLowerCase();
  if (l.startsWith(p)) return { score: 1000 - (l.length - p.length), hits: [...p].map((_, i) => i) };
  const at = l.indexOf(p);
  if (at >= 0) return { score: (at > 0 && !WORD.test(l[at - 1] ?? "") ? 650 : l[at - 1] === "_" ? 650 : 500) - at, hits: [...p].map((_, i) => at + i) };
  if (p.length < 2) return null;
  const hits: number[] = [];
  let j = 0;
  for (let i = 0; i < l.length && j < p.length; i++) if (l[i] === p[j]) (hits.push(i), j++);
  if (j < p.length) return null;
  return { score: 200 - (hits[hits.length - 1] - hits[0]), hits };
}

/** 光标是不是在字符串 / 注释里面（里面不弹） */
function inLiteral(sql: string, caret: number): boolean {
  let off = 0;
  for (const t of tokenize(sql)) {
    const end = off + t.s.length;
    if (caret > off && caret <= end) {
      if (t.k === "str") return t.s.length < 2 || !t.s.endsWith("'") || caret < end;
      if (t.k === "com") return !(t.s.startsWith("/*") && t.s.length >= 4 && t.s.endsWith("*/")) || caret < end;
    }
    if (off >= caret) break;
    off = end;
  }
  return false;
}

/** 光标所在的语句的起点（不含分号之前的语句） */
function stmtStart(sql: string, caret: number): number {
  const list = splitStatements(sql);
  const hit = list.find(s => s.start <= caret && (caret < s.end || (caret === s.end && !s.text.trimEnd().endsWith(";"))));
  if (hit) return hit.start;
  const prev = [...list].reverse().find(s => s.end <= caret);
  return prev ? prev.end : 0;
}

export interface TableRef {
  schema?: string;
  table: string;
  alias?: string;
}

const NAME = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|[A-Za-z_][\w$]*)`;
const FROM_RE = new RegExp(String.raw`\b(?:from|join|update|into)\s+(${NAME}(?:\s*\.\s*${NAME})?)(?:\s+(?:as\s+)?(${NAME}))?`, "gi");
const COMMA_RE = new RegExp(String.raw`^\s*,\s*(${NAME}(?:\s*\.\s*${NAME})?)(?:\s+(?:as\s+)?(${NAME}))?`, "i");

/** 这条语句里 FROM / JOIN / UPDATE / INTO 后面出现的表和别名 */
export function referencedTables(stmt: string): TableRef[] {
  const out: TableRef[] = [];
  const add = (full: string, alias?: string) => {
    const parts = full.split(/\s*\.\s*/).map(unq);
    const a = alias && !NOT_ALIAS.has(alias.toLowerCase()) ? unq(alias) : undefined;
    out.push({ schema: parts.length > 1 ? parts[0] : undefined, table: parts[parts.length - 1], alias: a });
  };
  for (const m of stmt.matchAll(FROM_RE)) {
    add(m[1], m[2]);
    let rest = stmt.slice((m.index ?? 0) + m[0].length);
    for (let c = COMMA_RE.exec(rest); c; c = COMMA_RE.exec(rest)) {
      add(c[1], c[2]);
      rest = rest.slice(c[0].length);
    }
  }
  return out;
}

// ───────── 主函数 ─────────

export function complete(sql: string, caret: number, src: CompSource, explicit = false): CompResult | null {
  if (inLiteral(sql, caret)) return null;
  const d = src.dialect;

  // 光标所在的词（前面可以带一个引号）
  let from = caret;
  while (from > 0 && WORD.test(sql[from - 1])) from--;
  let prefix = sql.slice(from, caret);
  let q: string | undefined;
  if (from > 0 && (sql[from - 1] === '"' || sql[from - 1] === "`")) {
    q = sql[from - 1];
    from--;
  }
  let to = caret;
  while (to < sql.length && WORD.test(sql[to])) to++;
  if (q && sql[to] === q) to++;

  // `x.` 后面：x 是别名 / 表 / schema
  let qualifier: string | undefined;
  let qualSchema: string | undefined;
  if (sql[from - 1] === ".") {
    let e = from - 1;
    let s = e;
    const qc = sql[e - 1];
    if (qc === '"' || qc === "`") {
      s = sql.lastIndexOf(qc, e - 2);
      if (s < 0) return null;
      qualifier = sql.slice(s + 1, e - 1);
    } else {
      while (s > 0 && WORD.test(sql[s - 1])) s--;
      qualifier = sql.slice(s, e);
    }
    if (!qualifier) return null;
    if (sql[s - 1] === ".") {
      let s2 = s - 1;
      while (s2 > 0 && WORD.test(sql[s2 - 1])) s2--;
      qualSchema = sql.slice(s2, s - 1);
    }
  }
  if (!explicit && !prefix && !qualifier) return null;
  // 只是在写一个数字
  if (/^\d/.test(prefix)) return null;

  const st = stmtStart(sql, caret);
  const before = sql.slice(st, from);
  const stmt = sql.slice(st, Math.max(sql.length, caret)).split(/;/)[0] ?? "";
  const refs = referencedTables(stmt);

  const items: CompItem[] = [];
  const push = (label: string, kind: CompKind, boost: number, o: { insert?: string; detail?: string; cursor?: number; trigger?: string } = {}) => {
    const m = match(o.trigger ?? label, prefix);
    if (!m) return;
    items.push({ label, kind, insert: o.insert ?? label, detail: o.detail, cursor: o.cursor, hits: o.trigger ? [] : m.hits, score: m.score + boost });
  };
  const putTables = (list: CompTable[], boost: number) => list.forEach(t => push(t.name, t.kind, boost, { insert: ident(d, t.name, q), detail: t.kind }));
  const putColumns = (list: CompColumn[], boost: number, from?: string) => list.forEach(c => push(c.name, "column", boost + (c.pk ? 5 : 0), { insert: ident(d, c.name, q), detail: from ? `${c.dataType} · ${from}` : c.dataType }));

  if (qualifier) {
    const ql = qualifier.toLowerCase();
    const byAlias = refs.find(r => r.alias?.toLowerCase() === ql);
    const known = src.tables.find(t => t.name.toLowerCase() === ql);
    const sc = src.schemas.find(s => s.toLowerCase() === ql) ?? (ql === src.schema.toLowerCase() ? src.schema : undefined);
    const byName = refs.find(r => r.table.toLowerCase() === ql);
    if (byAlias) putColumns(src.columns(byAlias.schema ?? qualSchema, byAlias.table) ?? [], 500);
    else if (known) putColumns(src.columns(qualSchema, known.name) ?? [], 500);
    else if (sc !== undefined) putTables(sc === src.schema ? src.tables : (src.tablesIn(sc) ?? []), 500);
    else if (byName) putColumns(src.columns(byName.schema ?? qualSchema, byName.table) ?? [], 500);
    else return null;
  } else {
    // 光标前最近的关键字，决定先给表还是先给字段
    const toks = tokenize(before);
    let kw = "";
    let kwEnd = 0;
    let off = 0;
    for (const t of toks) {
      off += t.s.length;
      if (t.k === "kw") (kw = t.s.toLowerCase(), (kwEnd = off));
    }
    const rest = before.slice(kwEnd);
    const tableCtx = TABLE_CTX.has(kw) && (/^\s*$/.test(rest) || /,\s*$/.test(rest));
    const atStart = before.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim() === "";
    const columnCtx = !tableCtx && !!kw && !/^(create|alter|drop|table|index|view|database|schema)$/.test(kw);

    if (tableCtx) {
      putTables(src.tables, 500);
      src.schemas.forEach(s => push(s, "schema", 300, { insert: ident(d, s, q), detail: "schema" }));
    } else {
      if (columnCtx)
        for (const r of refs) putColumns(src.columns(r.schema, r.table) ?? [], 500, refs.length > 1 ? (r.alias ?? r.table) : undefined);
      putTables(src.tables, columnCtx ? 50 : 200);
    }
    if (atStart) for (const s of SNIPPETS) push(s.label, "snippet", 400, { insert: s.insert, detail: s.detail, cursor: s.cursor, trigger: s.trigger });
    if (!tableCtx) {
      const fns = d === "postgresql" ? FN_PG : FN_MYSQL;
      fns.forEach(f => push(f, "function", columnCtx ? 100 : 20, { insert: `${f}()`, cursor: f.length + 1, detail: "function" }));
      (d === "postgresql" ? TYPES_PG : TYPES_MYSQL).forEach(t => push(t, "type", 0, { detail: "data type" }));
    }
    KEYWORDS.forEach(k => push(k, "keyword", tableCtx ? 0 : 300));
  }

  // 同名去重（同一个词既是关键字又是函数时保留分高的）
  const best = new Map<string, CompItem>();
  for (const it of items) {
    const key = `${it.kind === "keyword" || it.kind === "type" || it.kind === "function" ? "k" : it.kind}:${it.label.toLowerCase()}${it.kind === "column" ? `:${it.detail}` : ""}`;
    const old = best.get(key);
    if (!old || it.score > old.score) best.set(key, it);
  }
  let list = [...best.values()].sort((a, b) => b.score - a.score || a.label.length - b.label.length || a.label.localeCompare(b.label)).slice(0, 80);
  prefix = prefix.toLowerCase();
  // 已经完整输入了唯一的一个词：没必要再弹
  if (list.length === 1 && list[0].kind !== "snippet" && list[0].label.toLowerCase() === prefix && !explicit) list = [];
  return list.length ? { from, to, items: list } : null;
}

/** 把选中的候选写进 SQL，返回新文本和光标位置 */
export function applyItem(sql: string, r: CompResult, item: CompItem): { value: string; caret: number } {
  const value = sql.slice(0, r.from) + item.insert + sql.slice(r.to);
  return { value, caret: r.from + (item.cursor ?? item.insert.length) };
}
