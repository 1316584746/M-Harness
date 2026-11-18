import { quoteIdent, type DbDialect } from "../../../shared/db";

/** 筛选 / 排序的可视化条件 → WHERE / ORDER BY 片段（不带关键字）。纯函数 */

export type FilterOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "contains" | "notcontains" | "starts" | "ends" | "null" | "notnull" | "in" | "notin";

export const OPS: Array<{ id: FilterOp; label: string; value: boolean }> = [
  { id: "eq", label: "等于", value: true },
  { id: "ne", label: "不等于", value: true },
  { id: "gt", label: "大于", value: true },
  { id: "ge", label: "大于等于", value: true },
  { id: "lt", label: "小于", value: true },
  { id: "le", label: "小于等于", value: true },
  { id: "contains", label: "包含", value: true },
  { id: "notcontains", label: "不包含", value: true },
  { id: "starts", label: "开头是", value: true },
  { id: "ends", label: "结尾是", value: true },
  { id: "in", label: "在列表中", value: true },
  { id: "notin", label: "不在列表中", value: true },
  { id: "null", label: "为空", value: false },
  { id: "notnull", label: "不为空", value: false },
];

export interface Cond {
  id: number;
  col: string;
  op: FilterOp;
  val: string;
  /** 停用的条件不参与筛选 */
  on: boolean;
}

export interface SortKey {
  id: number;
  col: string;
  dir: "asc" | "desc";
  on: boolean;
}

const NUMERIC = /int|numeric|decimal|float|double|real|serial|number|money/i;

/** 字符串字面量：引号翻倍；MySQL 里反斜杠也要翻倍；PostgreSQL 里有反斜杠就用 E'' 写法（和只读检查对反斜杠的理解一致） */
export function literal(dialect: DbDialect, v: string, type: string, forceText = false): string {
  if (!forceText && NUMERIC.test(type) && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  const q = v.replace(/'/g, "''");
  if (v.includes("\\")) return dialect === "mysql" ? `'${q.replace(/\\/g, "\\\\")}'` : `E'${q.replace(/\\/g, "\\\\")}'`;
  return `'${q}'`;
}

const splitList = (v: string) =>
  v
    .split(/[,，\n]/)
    .map(s => s.trim())
    .filter(Boolean);

export function condSql(dialect: DbDialect, c: Cond, type: string): string | undefined {
  if (!c.on || !c.col) return undefined;
  const col = quoteIdent(dialect, c.col);
  const text = dialect === "postgresql" ? `${col}::text` : col;
  const like = dialect === "postgresql" ? "ILIKE" : "LIKE";
  const def = OPS.find(o => o.id === c.op);
  if (!def) return undefined;
  if (c.op === "null") return `${col} IS NULL`;
  if (c.op === "notnull") return `${col} IS NOT NULL`;
  if (c.val === "") return undefined;
  const lit = (v: string, force = false) => literal(dialect, v, type, force);
  switch (c.op) {
    case "eq":
      return `${col} = ${lit(c.val)}`;
    case "ne":
      return `${col} <> ${lit(c.val)}`;
    case "gt":
      return `${col} > ${lit(c.val)}`;
    case "ge":
      return `${col} >= ${lit(c.val)}`;
    case "lt":
      return `${col} < ${lit(c.val)}`;
    case "le":
      return `${col} <= ${lit(c.val)}`;
    case "contains":
      return `${text} ${like} ${lit(`%${c.val}%`, true)}`;
    case "notcontains":
      return `${text} NOT ${like} ${lit(`%${c.val}%`, true)}`;
    case "starts":
      return `${text} ${like} ${lit(`${c.val}%`, true)}`;
    case "ends":
      return `${text} ${like} ${lit(`%${c.val}`, true)}`;
    case "in":
    case "notin": {
      const items = splitList(c.val);
      return items.length ? `${col} ${c.op === "notin" ? "NOT " : ""}IN (${items.map(i => lit(i)).join(", ")})` : undefined;
    }
  }
}

/** 所有有效条件拼成一个 WHERE 片段；join 决定「全部满足」还是「任一满足」 */
export function buildWhere(dialect: DbDialect, conds: Cond[], types: Record<string, string>, join: "and" | "or" = "and"): string {
  const parts = conds.map(c => condSql(dialect, c, types[c.col] ?? "")).filter((s): s is string => !!s);
  return parts.join(join === "and" ? " AND " : " OR ");
}

export function buildOrder(dialect: DbDialect, sorts: SortKey[]): string {
  return sorts
    .filter(s => s.on && s.col)
    .map(s => `${quoteIdent(dialect, s.col)} ${s.dir === "desc" ? "DESC" : "ASC"}`)
    .join(", ");
}
