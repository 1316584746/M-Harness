import { useEffect, useMemo, useState } from "react";
import type { Connection } from "../../../../shared/connections";
import type { DbFocus } from "../../../../shared/db";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import type { DbScope } from "../../lib/dbAiContext";

/**
 * AI 助手输入框上方的「库」选择：连接 / 数据库 / schema。
 * 默认跟着数据库页当前打开的标签走，也可以自己改；AI 提问时会带上这里选的库和表结构。
 */
export function AiContextBar({ focus, conns, onChange }: { focus: DbFocus | null; conns: Connection[]; onChange: (s: DbScope | null) => void }) {
  const [connId, setConnId] = useState("");
  const [database, setDatabase] = useState("");
  const [schema, setSchema] = useState("");
  const [dbs, setDbs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);

  const conn = conns.find(c => c.id === connId);
  const pg = conn?.fields.dbType === "postgresql";
  const defaultDb = (c?: Connection) => c?.fields.database ?? "";

  // 数据库页换了标签 / 连接列表变了：跟过去
  const fk = `${focus?.connId ?? ""}|${focus?.database ?? ""}|${focus?.schema ?? ""}`;
  const ck = conns.map(c => c.id).join(",");
  useEffect(() => {
    const c = conns.find(x => x.id === focus?.connId) ?? conns.find(x => x.id === connId) ?? conns[0];
    if (!c) return setConnId("");
    setConnId(c.id);
    setDatabase(c.id === focus?.connId ? (focus?.database ?? defaultDb(c)) : c.id === connId ? database : defaultDb(c));
    setSchema(c.id === focus?.connId ? (focus?.schema ?? "") : c.id === connId ? schema : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fk, ck]);

  useEffect(() => {
    if (!connId) return setDbs([]);
    let off = false;
    void api.dbDatabases(connId).then(r => !off && setDbs(r.ok ? r.data : []));
    return () => void (off = true);
  }, [connId]);

  useEffect(() => {
    if (!connId || !pg) return setSchemas([]);
    let off = false;
    void api.dbSchemas({ connectionId: connId, database: database || undefined }).then(r => {
      if (off) return;
      const l = r.ok ? r.data.map(s => s.name) : [];
      setSchemas(l);
      setSchema(cur => (l.includes(cur) ? cur : l.includes("public") ? "public" : (l[0] ?? "")));
    });
    return () => void (off = true);
  }, [connId, database, pg]);

  const scope = useMemo<DbScope | null>(() => (connId ? { connId, database, schema: pg ? schema : "" } : null), [connId, database, schema, pg]);
  useEffect(() => onChange(scope), [scope, onChange]);

  if (!conns.length) return null;
  const dbOpts = database && !dbs.includes(database) ? [database, ...dbs] : dbs;
  return (
    <div className="ai-ctx" data-testid="ai-ctx" title="AI 提问时会带上这里选的库，以及打开的表的结构">
      <label className="ai-ctx-sel">
        <Icon name="database" size={12} />
        <select data-testid="ai-ctx-conn" value={connId} onChange={e => (setConnId(e.target.value), setDatabase(defaultDb(conns.find(c => c.id === e.target.value))), setSchema(""))}>
          {conns.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="ai-ctx-sel">
        <Icon name="box" size={12} />
        <select data-testid="ai-ctx-db" value={database} onChange={e => (setDatabase(e.target.value), setSchema(""))}>
          {!dbOpts.length && <option value="">（默认库）</option>}
          {dbOpts.map(d => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      {pg && (
        <label className="ai-ctx-sel">
          <Icon name="folder" size={12} />
          <select data-testid="ai-ctx-schema" value={schema} onChange={e => setSchema(e.target.value)}>
            {schema && !schemas.includes(schema) && <option value={schema}>{schema}</option>}
            {schemas.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
