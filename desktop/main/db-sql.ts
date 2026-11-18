import { DB_PAGE_MAX, quoteIdent, type DbDialect, type DbRowOp } from "../shared/db";

/**
 * 数据库工作台用的 SQL 拼装（纯函数，不连库）。
 * 标识符一律加引号转义；值一律走参数，不拼进 SQL 文本。
 */

export interface Stmt {
  sql: string;
  params: unknown[];
  /** 这条语句应该刚好影响几行；不符就回滚整批 */
  expect?: number;
}

/** 表的全名：PostgreSQL 是 "schema"."table"；MySQL 是 `库`.`表` */
export function qualified(dialect: DbDialect, schema: string | undefined, table: string): string {
  return (schema ? quoteIdent(dialect, schema) + "." : "") + quoteIdent(dialect, table);
}

/** 去掉用户顺手写的结尾分号 */
const frag = (s?: string) => (s ?? "").trim().replace(/[;\s]+$/, "");

const ph = (dialect: DbDialect, n: number) => (dialect === "mysql" ? "?" : `$${n}`);

/** 分页读取。where / orderBy 前后各留一个换行：就算用户写了 -- 注释，也吃不掉后面的 LIMIT */
export function buildSelect(dialect: DbDialect, schema: string | undefined, table: string, o: { where?: string; orderBy?: string; limit?: number; offset?: number }): string {
  const limit = Math.min(Math.max(1, Math.floor(o.limit ?? 200)), DB_PAGE_MAX);
  const offset = Math.max(0, Math.floor(o.offset ?? 0));
  const where = frag(o.where);
  const orderBy = frag(o.orderBy);
  let sql = `SELECT * FROM ${qualified(dialect, schema, table)}`;
  if (where) sql += `\nWHERE (\n${where}\n)`;
  if (orderBy) sql += `\nORDER BY\n${orderBy}\n`;
  sql += `\nLIMIT ${limit}`;
  if (offset) sql += ` OFFSET ${offset}`;
  return sql;
}

export function buildCount(dialect: DbDialect, schema: string | undefined, table: string, where?: string): string {
  const w = frag(where);
  return `SELECT COUNT(*) FROM ${qualified(dialect, schema, table)}${w ? `\nWHERE (\n${w}\n)` : ""}`;
}

const keys = (o: Record<string, unknown>) => Object.keys(o);

/** 把一批行操作变成带参数的语句。主键值不能为空（空主键没法定位到唯一一行） */
export function buildOps(dialect: DbDialect, schema: string | undefined, table: string, ops: DbRowOp[]): Stmt[] {
  const t = qualified(dialect, schema, table);
  const q = (c: string) => quoteIdent(dialect, c);
  return ops.map((op, i) => {
    const at = `第 ${i + 1} 条`;
    if (op.kind === "insert") {
      const cols = keys(op.values);
      if (!cols.length) return { sql: dialect === "mysql" ? `INSERT INTO ${t} () VALUES ()` : `INSERT INTO ${t} DEFAULT VALUES`, params: [], expect: 1 };
      return { sql: `INSERT INTO ${t} (${cols.map(q).join(", ")}) VALUES (${cols.map((_, n) => ph(dialect, n + 1)).join(", ")})`, params: cols.map(c => op.values[c]), expect: 1 };
    }
    const kc = keys(op.key);
    if (!kc.length) throw new Error(`${at}：这张表没有主键，不能${op.kind === "delete" ? "删除" : "修改"}行`);
    for (const c of kc) if (op.key[c] === null || op.key[c] === undefined) throw new Error(`${at}：主键 ${c} 是空的，没法定位这一行`);
    if (op.kind === "delete") {
      return { sql: `DELETE FROM ${t} WHERE ${kc.map((c, n) => `${q(c)} = ${ph(dialect, n + 1)}`).join(" AND ")}`, params: kc.map(c => op.key[c]), expect: 1 };
    }
    const vc = keys(op.values);
    if (!vc.length) throw new Error(`${at}：没有要修改的字段`);
    return {
      sql: `UPDATE ${t} SET ${vc.map((c, n) => `${q(c)} = ${ph(dialect, n + 1)}`).join(", ")} WHERE ${kc.map((c, n) => `${q(c)} = ${ph(dialect, vc.length + n + 1)}`).join(" AND ")}`,
      params: [...vc.map(c => op.values[c]), ...kc.map(c => op.key[c])],
      expect: 1,
    };
  });
}
