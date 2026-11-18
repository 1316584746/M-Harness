import type { Connection } from "../../../shared/connections";
import { api } from "../api";
import { formatDbPreamble, type DbScope } from "./dbPreamble";

export type { DbScope } from "./dbPreamble";

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => Promise.race([p, new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);

/** 取表清单和（如果有打开的表）字段，拼成上下文。取不到的部分跳过，不影响发送 */
export async function buildDbPreamble(conn: Connection, scope: DbScope, table?: string): Promise<string> {
  const pg = conn.fields.dbType === "postgresql";
  const ref = { connectionId: conn.id, database: scope.database || undefined, schema: pg ? scope.schema || undefined : undefined };
  const [tables, structure] = await Promise.all([
    within(api.dbTables(ref).then(r => (r.ok ? r.data : undefined)), 4000).catch(() => undefined),
    table ? within(api.dbStructure({ ...ref, table }).then(r => (r.ok ? r.data : null)), 4000).catch(() => null) : Promise.resolve(null),
  ]);
  return formatDbPreamble({ conn, scope, tables, table, structure });
}
