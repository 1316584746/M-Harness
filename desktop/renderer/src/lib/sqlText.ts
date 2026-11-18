import { quoteIdent, type DbColumn, type DbDialect } from "../../../shared/db";

/** SQL 文本相关的小工具：语法高亮分词、按光标取当前语句、导出 CSV / JSON / INSERT。纯函数，不碰 DOM（下载除外） */

// ───────── 语法高亮 ─────────

export type TokKind = "kw" | "fn" | "str" | "id" | "num" | "com" | "txt";
export interface Tok {
  k: TokKind;
  s: string;
}

const KEYWORDS = new Set(
  (
    "select from where and or not in is null like ilike between order by group having limit offset join left right inner outer full cross natural on using as distinct union all intersect except " +
    "insert into values update set delete create alter drop truncate table index view database schema primary key foreign references unique default check constraint add column rename to if exists " +
    "with recursive case when then else end asc desc true false returning over partition window fetch next rows only for show describe explain analyze begin commit rollback use"
  ).split(" "),
);

const RE = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?|`[^`]*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w$]*)|([\s\S])/g;

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  const push = (k: TokKind, s: string) => {
    const last = out[out.length - 1];
    if (last && last.k === k && k === "txt") last.s += s;
    else out.push({ k, s });
  };
  for (const m of sql.matchAll(RE)) {
    if (m[1] !== undefined) push("com", m[1]);
    else if (m[2] !== undefined) push("str", m[2]);
    else if (m[3] !== undefined) push("id", m[3]);
    else if (m[4] !== undefined) push("num", m[4]);
    else if (m[5] !== undefined) {
      const after = sql.slice((m.index ?? 0) + m[5].length).match(/^\s*\(/);
      push(KEYWORDS.has(m[5].toLowerCase()) ? "kw" : after ? "fn" : "txt", m[5]);
    } else push("txt", m[6]);
  }
  return out;
}

// ───────── 按光标取当前语句 ─────────

/** 把脚本按分号切成语句（引号、注释里的分号不算）；返回每条的起止位置 */
export function splitStatements(sql: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  for (const m of sql.matchAll(RE)) {
    if (m[6] === ";") {
      const end = (m.index ?? 0) + 1;
      out.push({ start, end, text: sql.slice(start, end) });
      start = end;
    }
  }
  if (start < sql.length) out.push({ start, end: sql.length, text: sql.slice(start) });
  return out.filter(s => s.text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|[\s;]/g, "") !== "");
}

/** 光标所在的那条语句；光标在两条之间（空白里）时取前一条 */
export function statementAt(sql: string, caret: number): string {
  const list = splitStatements(sql);
  if (!list.length) return "";
  const hit = list.find(s => caret >= s.start && caret <= s.end) ?? [...list].reverse().find(s => s.end <= caret) ?? list[0];
  return hit.text.trim();
}

export interface StmtMark {
  start: number;
  end: number;
  /** 去掉首尾空白的语句文本 */
  text: string;
  /** 语句第一个真正有内容的字符所在的行（0 起）；前面的空行、注释不算 */
  line: number;
}

/** 编辑器里每条完整语句的位置，用来在行首放「运行」按钮；同一行有两条时只有第一条有 */
export function statementMarks(sql: string): StmtMark[] {
  const out: StmtMark[] = [];
  const seen = new Set<number>();
  for (const s of splitStatements(sql)) {
    let i = s.start;
    for (;;) {
      while (i < s.end && /\s/.test(sql[i])) i++;
      if (sql.startsWith("--", i)) {
        const n = sql.indexOf("\n", i);
        i = n < 0 ? s.end : n + 1;
      } else if (sql.startsWith("/*", i)) {
        const n = sql.indexOf("*/", i + 2);
        i = n < 0 ? s.end : n + 2;
      } else break;
    }
    let line = 0;
    for (let k = 0; k < i; k++) if (sql.charCodeAt(k) === 10) line++;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({ start: s.start, end: s.end, text: s.text.trim(), line });
  }
  return out;
}

/** 注释 / 取消注释选中的行（没选就是光标所在行）：整段都已经是注释就去掉，否则每行前面加 -- ；返回新文本和选区（整行） */
export function toggleComment(sql: string, a: number, b: number): { value: string; a: number; b: number } {
  const from = sql.lastIndexOf("\n", a - 1) + 1;
  const lastEnd = b > a && sql[b - 1] === "\n" ? b - 1 : b;
  const nl = sql.indexOf("\n", lastEnd);
  const to = nl < 0 ? sql.length : nl;
  const lines = sql.slice(from, to).split("\n");
  const body = lines.filter(l => l.trim() !== "");
  const un = body.length > 0 && body.every(l => /^\s*--/.test(l));
  const next = lines
    .map(l => {
      if (l.trim() === "") return l;
      return un ? l.replace(/^(\s*)-- ?/, "$1") : l.replace(/^(\s*)/, "$1-- ");
    })
    .join("\n");
  return { value: sql.slice(0, from) + next + sql.slice(to), a: from, b: from + next.length };
}

// ───────── 格式化 ─────────

const BREAK_BEFORE = new Set(["from", "where", "having", "limit", "offset", "union", "intersect", "except", "values", "returning", "set"]);
const JOIN_MOD = new Set(["left", "right", "inner", "full", "cross", "natural", "outer"]);
const LIST_CLAUSE = new Set(["select", "set", "group", "order"]);

/** 简单的 SQL 格式化：关键字大写，主要子句另起一行，SELECT / SET 的字段一行一个，AND / OR 缩进；括号里（子查询、函数参数）保持原样不拆行 */
export function formatSql(sql: string): string {
  interface T {
    s: string;
    k: "kw" | "com" | "w" | "p";
    lc: string;
    ws: boolean;
    fn?: boolean;
  }
  const toks: T[] = [];
  let ws = false;
  for (const t of tokenize(sql)) {
    if (t.k === "txt") {
      for (const m of t.s.matchAll(/\s+|[(),;]|[^\s(),;]+/g)) {
        if (/^\s/.test(m[0])) ws = true;
        else {
          toks.push({ s: m[0], k: /^[(),;]$/.test(m[0]) ? "p" : "w", lc: m[0].toLowerCase(), ws });
          ws = false;
        }
      }
      continue;
    }
    // t.key 这种点后面的词是字段名，不当关键字
    const kw = t.k === "kw" && (ws || !toks[toks.length - 1]?.s.endsWith("."));
    toks.push({ s: kw ? t.s.toUpperCase() : t.s, k: kw ? "kw" : t.k === "com" ? "com" : "w", lc: t.s.toLowerCase(), ws, fn: t.k === "fn" });
    ws = false;
  }

  let out = "";
  let depth = 0;
  let clause = "";
  let pendingBreak = false;
  const nl = (ind = 0) => {
    out = out.replace(/\n *$/, "").replace(/[ \t]+$/, "") + "\n" + " ".repeat(ind);
  };
  const atLineStart = () => out === "" || /\n *$/.test(out);
  const kwAt = (i: number) => (toks[i]?.k === "kw" ? toks[i].lc : "");

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1];
    if (t.s === ";") {
      out = out.trimEnd() + ";";
      depth = 0;
      clause = "";
      pendingBreak = false;
      if (i < toks.length - 1) out += "\n\n";
      continue;
    }
    if (pendingBreak && !(t.k === "kw" && t.lc === "distinct")) {
      pendingBreak = false;
      nl(2);
    }
    if (t.k === "kw" && depth === 0) {
      const next = kwAt(i + 1);
      if (t.lc === "join") {
        if (!(prev?.k === "kw" && JOIN_MOD.has(prev.lc))) nl();
      } else if (JOIN_MOD.has(t.lc)) {
        if (!(prev?.k === "kw" && JOIN_MOD.has(prev.lc))) {
          let j = i;
          while (kwAt(j + 1) && JOIN_MOD.has(kwAt(j + 1))) j++;
          if (kwAt(j + 1) === "join") nl();
        }
      } else if ((t.lc === "group" || t.lc === "order") && next === "by") nl();
      else if (BREAK_BEFORE.has(t.lc)) {
        if (!(t.lc === "union" && prev?.lc === "all") && out.trim() !== "") nl();
      } else if ((t.lc === "and" || t.lc === "or") && (clause === "where" || clause === "on" || clause === "having")) nl(2);
      if (["select", "from", "where", "set", "group", "order", "having", "limit", "values", "on"].includes(t.lc)) clause = t.lc;
      if (t.lc === "select" || t.lc === "set") pendingBreak = true;
    }
    if (t.k === "com" && t.s.startsWith("--") && !atLineStart()) {
      out += " " + t.s;
      nl(clause && LIST_CLAUSE.has(clause) ? 2 : 0);
      continue;
    }
    // 空格
    if (!atLineStart()) {
      const glue = t.s === ")" || t.s === "," || prev?.s === "(" || t.s.startsWith(".") || prev?.s.endsWith(".") || (t.s === "(" && (prev?.fn || (!t.ws && prev?.k === "w")));
      const space = !glue && (t.ws || prev?.s === "," || ((prev?.k === "kw" || t.k === "kw") && prev?.k !== "p" && t.k !== "p"));
      if (space) out += " ";
    }
    out += t.s;
    if (t.s === "(") depth++;
    else if (t.s === ")") depth = Math.max(0, depth - 1);
    else if (t.s === "," && depth === 0 && (clause === "select" || clause === "set")) nl(2);
    if (t.k === "com" && t.s.startsWith("--")) nl();
  }
  return out.trim();
}

/** 写语句要先让用户确认；这里只看第一个词 */
export const isReadSql = (sql: string): boolean => /^[(\s]*(select|with|show|describe|desc|explain|values|table)\b/i.test(sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, ""));

// ───────── 单元格显示 / 编辑 ─────────

export const isNull = (v: unknown): boolean => v === null || v === undefined;

/** 单元格显示成文字（空值显示成 NULL，由样式单独着色） */
export function cellText(v: unknown): string {
  if (isNull(v)) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 被截断的长文本 / 二进制：只能看，不能改（改了会把残缺内容写回去） */
export const isLossy = (v: unknown): boolean => typeof v === "string" && (/…（共 \d+ 字符，已截断）$/.test(v) || /^<二进制 \d+ 字节>$/.test(v));

// ───────── 导出 ─────────

export const toCsv = (columns: DbColumn[], rows: unknown[][]): string => {
  const esc = (v: unknown) => {
    if (isNull(v)) return "";
    const s = cellText(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return "\uFEFF" + [columns.map(c => esc(c.name)).join(","), ...rows.map(r => r.map(esc).join(","))].join("\r\n") + "\r\n";
};

export const toJson = (columns: DbColumn[], rows: unknown[][]): string =>
  JSON.stringify(
    rows.map(r => Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null]))),
    null,
    2,
  );

export const toInsertSql = (dialect: DbDialect, table: string, columns: DbColumn[], rows: unknown[][]): string => {
  const lit = (v: unknown) => (isNull(v) ? "NULL" : typeof v === "number" || typeof v === "boolean" ? String(v) : "'" + cellText(v).replace(/'/g, "''") + "'");
  const head = `INSERT INTO ${quoteIdent(dialect, table)} (${columns.map(c => quoteIdent(dialect, c.name)).join(", ")}) VALUES`;
  return rows.map(r => `${head} (${r.map(lit).join(", ")});`).join("\n") + "\n";
};

/** 文件名里不能有的字符换成下划线 */
export const safeName = (s: string): string => s.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "export";
