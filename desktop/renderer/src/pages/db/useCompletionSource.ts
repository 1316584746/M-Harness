import { useEffect, useMemo, useRef, useState } from "react";
import type { Connection } from "../../../../shared/connections";
import type { DbDialect } from "../../../../shared/db";
import { api } from "../../api";
import type { CompColumn, CompSource, CompTable } from "../../lib/sqlComplete";

/**
 * 给 SQL 编辑器的联想提供「当前库里有什么」：表和视图一进来就取，
 * 某张表的字段、别的 schema 的表用到时才取（取到后 version 加一，编辑器会重新算一次候选）。
 */
export function useCompletionSource(conn: Connection | undefined, dbName: string, schema: string, schemas: string[]): { src: CompSource; version: number } {
  const dialect = (conn?.fields.dbType ?? "postgresql") as DbDialect;
  const pg = dialect === "postgresql";
  const scope = pg ? schema || "public" : dbName;
  const [tables, setTables] = useState<CompTable[]>([]);
  const [version, setVersion] = useState(0);
  const cols = useRef(new Map<string, CompColumn[] | "loading">());
  const others = useRef(new Map<string, CompTable[] | "loading">());

  const connId = conn?.id;
  useEffect(() => {
    cols.current = new Map();
    others.current = new Map();
    setTables([]);
    if (!connId || !scope) return;
    let live = true;
    void api.dbTables({ connectionId: connId, database: dbName || undefined, schema: scope }).then(r => live && setTables(r.ok ? r.data.map(t => ({ name: t.name, kind: t.kind })) : []));
    return () => {
      live = false;
    };
  }, [connId, dbName, scope]);

  const src = useMemo<CompSource>(
    () => ({
      dialect,
      schema: scope,
      tables,
      schemas,
      columns(sc, table) {
        if (!connId) return [];
        const where = sc ?? scope;
        // 只有当前 schema 里确实有这张表（或明确写了 schema）才去取，别每敲一个字母都去问库
        const real = sc ? table : tables.find(t => t.name.toLowerCase() === table.toLowerCase())?.name;
        if (!real) return [];
        const key = `${where}|${real}`;
        const got = cols.current.get(key);
        if (got === "loading") return undefined;
        if (got) return got;
        cols.current.set(key, "loading");
        void api.dbStructure({ connectionId: connId, database: dbName || undefined, schema: where, table: real }).then(r => {
          cols.current.set(key, r.ok ? r.data.columns.map(c => ({ name: c.name, dataType: c.dataType, pk: c.pk })) : []);
          setVersion(v => v + 1);
        });
        return undefined;
      },
      tablesIn(sc) {
        if (!connId) return [];
        const got = others.current.get(sc);
        if (got === "loading") return undefined;
        if (got) return got;
        others.current.set(sc, "loading");
        void api.dbTables({ connectionId: connId, database: dbName || undefined, schema: sc }).then(r => {
          others.current.set(sc, r.ok ? r.data.map(t => ({ name: t.name, kind: t.kind })) : []);
          setVersion(v => v + 1);
        });
        return undefined;
      },
    }),
    [dialect, scope, tables, schemas, connId, dbName],
  );

  return { src, version };
}
