import type { Connection } from "../../../shared/connections";
import { isWritableEnv, type DbStructure, type DbTableInfo } from "../../../shared/db";

/** AI 助手当前用的库：连接 / 数据库 / schema（MySQL 没有 schema，留空） */
export interface DbScope {
  connId: string;
  database: string;
  schema: string;
}

export interface PreambleInfo {
  conn: Pick<Connection, "name" | "env" | "fields">;
  scope: Pick<DbScope, "database" | "schema">;
  tables?: DbTableInfo[];
  table?: string;
  structure?: DbStructure | null;
}

export const MAX_TABLES = 150;
export const MAX_COLS = 80;

/** 发给 AI 的数据库上下文（纯文本，不含任何密码）。AI 不能直接连库，所以让它写 SQL，由用户在 SQL 编辑器里跑 */
export function formatDbPreamble(i: PreambleInfo): string {
  const pg = i.conn.fields.dbType === "postgresql";
  const rw = isWritableEnv(i.conn.env);
  const lines = ["【数据库上下文】", `连接：${i.conn.name}（环境：${i.conn.env}，${pg ? "PostgreSQL" : "MySQL"}，${rw ? "可写" : "只读"}）`, `库：${i.scope.database || "（默认库）"}${pg && i.scope.schema ? `　schema：${i.scope.schema}` : ""}`];
  if (i.table) lines.push(`当前打开的表：${i.table}`);
  if (i.tables?.length) {
    const names = i.tables.slice(0, MAX_TABLES).map(t => (t.kind === "view" ? `${t.name}(视图)` : t.name));
    lines.push(`${pg ? "这个 schema" : "这个库"}里的表（共 ${i.tables.length} 张${i.tables.length > MAX_TABLES ? `，只列前 ${MAX_TABLES} 张` : ""}）：${names.join("、")}`);
  }
  if (i.table && i.structure) {
    lines.push(`表 ${i.table} 的字段：`);
    for (const c of i.structure.columns.slice(0, MAX_COLS)) lines.push(`- ${c.name} ${c.dataType}${c.pk ? " 主键" : ""}${c.nullable ? "" : " 非空"}${c.comment ? ` -- ${c.comment}` : ""}`);
    if (i.structure.columns.length > MAX_COLS) lines.push(`…还有 ${i.structure.columns.length - MAX_COLS} 个字段`);
  }
  lines.push("你没有连接这个库的权限，不能执行 SQL。请根据上面的结构写出可以直接粘贴到「数据库」页 SQL 编辑器里运行的 SQL，并简要说明；只读环境只写查询语句；不确定某个字段是否存在时，先说明再写。", "【问题】");
  return lines.join("\n");
}
