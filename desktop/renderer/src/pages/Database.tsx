import { useCallback, useEffect, useRef, useState } from "react";
import type { Connection } from "../../../shared/connections";
import { quoteIdent, type DbDialect, type DbFocus } from "../../../shared/db";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { pruneQueries, type SavedQuery } from "../lib/savedQueries";
import { DbTree } from "./db/DbTree";
import { QueryView } from "./db/QueryView";
import { TableView } from "./db/TableView";

interface Tab {
  id: string;
  kind: "table" | "query";
  connId: string;
  database?: string;
  schema?: string;
  table?: string;
  title: string;
  sql?: string;
  /** 从「查询」里保存的某条打开的 / 保存过的 */
  savedId?: string;
  /** 「默认查询」的位置标记 */
  defKey?: string;
  dirty?: boolean;
}

const tableKey = (connId: string, database: string | undefined, schema: string | undefined, table: string) => `${connId}|${database ?? ""}|${schema ?? ""}|${table}`;

/**
 * 数据库：左边连接树，右边多个标签页（表数据 / 表结构 / SQL 查询）。
 * 直接连「设置 → 连接」里的数据库连接（MySQL / PostgreSQL），不需要装插件。
 * 开发 / 测试环境的库可以改数据，其他环境只读。
 */
export function Database({ active, onManage, onFocus }: { active: boolean; onManage: () => void; onFocus?: (f: DbFocus | null) => void }) {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [version, setVersion] = useState(0);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(() => {
    void api.connectionList().then(l => {
      setConns(l.filter(c => c.kind === "database"));
      setVersion(v => v + 1);
    });
  }, []);
  useEffect(() => {
    load();
    return api.onConnectionsChanged(load);
  }, [load]);

  // 连接被删了：它的标签一起关掉
  useEffect(() => {
    if (!conns) return;
    const ids = new Set(conns.map(c => c.id));
    pruneQueries(ids);
    setTabs(t => (t.every(x => ids.has(x.connId)) ? t : t.filter(x => ids.has(x.connId))));
  }, [conns]);
  useEffect(() => {
    if (activeId && !tabs.some(t => t.id === activeId)) setActiveId(tabs[tabs.length - 1]?.id ?? null);
  }, [tabs, activeId]);

  const connOf = (id: string) => conns?.find(c => c.id === id);

  const openTable = (c: Connection, database: string | undefined, schema: string | undefined, table: string) => {
    const id = "t:" + tableKey(c.id, database, schema, table);
    setTabs(t => (t.some(x => x.id === id) ? t : [...t, { id, kind: "table", connId: c.id, database, schema, table, title: table }]));
    setActiveId(id);
  };

  const openQuery = (c: Connection, database?: string, schema?: string, sql?: string) => {
    const id = `q:${++seq.current}:${Date.now()}`;
    const n = tabs.filter(t => t.kind === "query").length + 1;
    setTabs(t => [...t, { id, kind: "query", connId: c.id, database, schema, title: `查询 ${n}`, sql: sql ?? "" }]);
    setActiveId(id);
  };

  /** 「打开默认查询」：每个 连接 / 库 / schema 一个，已经开着就切过去，没有就新开 */
  const openDefault = (c: Connection, database?: string, schema?: string) => {
    const key = `${c.id}|${database ?? ""}|${schema ?? ""}`;
    const hit = tabs.find(t => t.defKey === key);
    if (hit) return setActiveId(hit.id);
    const id = `q:${++seq.current}:${Date.now()}`;
    setTabs(t => [...t, { id, kind: "query", connId: c.id, database, schema, title: "默认查询", sql: "", defKey: key }]);
    setActiveId(id);
  };

  /** 点左边「查询」里保存的某条：已经开着就切过去，没开就新开一个标签 */
  const openSaved = (q: SavedQuery) => {
    const c = connOf(q.connId);
    if (!c) return;
    const hit = tabs.find(t => t.savedId === q.id);
    if (hit) return setActiveId(hit.id);
    const id = `q:${++seq.current}:${Date.now()}`;
    setTabs(t => [...t, { id, kind: "query", connId: q.connId, database: q.database, schema: q.schema, title: q.name, sql: q.sql, savedId: q.id }]);
    setActiveId(id);
  };

  const closeTab = (id: string) => {
    const t = tabs.find(x => x.id === id);
    if (t?.dirty && !window.confirm(`「${t.title}」有修改还没提交，关掉会丢掉它们。确定关闭吗？`)) return;
    setTabs(list => list.filter(x => x.id !== id));
  };

  const cur = tabs.find(t => t.id === activeId);
  const activeKey = cur?.kind === "table" ? tableKey(cur.connId, cur.database, cur.schema, cur.table!) : null;
  const firstConn = (cur && connOf(cur.connId)) ?? conns?.[0];

  // 把当前标签的位置告诉右边的 AI 助手
  const fKey = cur ? `${cur.connId}|${cur.database ?? ""}|${cur.schema ?? ""}|${cur.kind === "table" ? cur.table : ""}` : "";
  useEffect(() => {
    onFocus?.(cur ? { connId: cur.connId, database: cur.database, schema: cur.schema, table: cur.kind === "table" ? cur.table : undefined } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fKey]);

  if (conns && conns.length === 0)
    return (
      <div className="page db-page" data-testid="database-page" hidden={!active}>
        <div className="page-head">
          <div>
            <h1>数据库</h1>
            <p>浏览表、查数据、写 SQL。开发 / 测试环境的库可以改数据，其他环境一律只读。</p>
          </div>
        </div>
        <div className="auto-empty" data-testid="db-empty">
          <span className="auto-empty-ico">
            <Icon name="database" size={30} />
          </span>
          <p>还没有数据库连接</p>
          <p style={{ fontSize: 12.5 }}>到「设置 → 连接 → 数据库」里添加 MySQL / PostgreSQL 连接，密码只加密保存在本机。</p>
          <button className="btn primary" onClick={onManage}>
            去添加连接
          </button>
        </div>
      </div>
    );

  return (
    <div className="dbw" data-testid="database-page" hidden={!active}>
      <DbTree conns={conns ?? []} version={version} activeKey={activeKey} activeSaved={cur?.savedId ?? null} onTable={openTable} onQuery={(c, d, s, sql) => openQuery(c, d, s, sql)} onDefaultQuery={openDefault} onOpenSaved={openSaved} onManage={onManage} />
      <section className="dbw-main">
        <div className="dbw-tabs" data-testid="db-tabs">
          {tabs.map(t => (
            <div
              key={t.id}
              className={`dbw-tab ${t.id === activeId ? "on" : ""}`}
              data-testid="db-tab"
              data-kind={t.kind}
              title={t.kind === "table" ? `${connOf(t.connId)?.name ?? ""} · ${[t.database, t.schema, t.table].filter(Boolean).join(".")}` : `${connOf(t.connId)?.name ?? ""} 的查询`}
              onClick={() => setActiveId(t.id)}
              onAuxClick={e => e.button === 1 && closeTab(t.id)}
            >
              <Icon name={t.kind === "table" ? "grid" : "terminal"} size={13} />
              <span className="dbw-tab-title">{t.title}</span>
              {t.dirty && <span className="dbw-dirty" title="有修改还没提交" />}
              <button
                className="dbw-tab-x"
                title="关闭"
                onClick={e => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          <button
            className="dbw-tab-add"
            data-testid="db-new-query"
            title="新建查询"
            disabled={!firstConn}
            onClick={() => {
              if (!firstConn) return;
              const pg = (firstConn.fields.dbType as DbDialect) === "postgresql";
              const t = cur?.kind === "table" ? cur : undefined;
              openQuery(firstConn, cur?.database ?? (firstConn.fields.database || undefined), cur?.schema ?? (pg ? "public" : undefined), t ? `SELECT * FROM ${pg && t.schema ? quoteIdent("postgresql", t.schema) + "." : ""}${quoteIdent(pg ? "postgresql" : "mysql", t.table!)} LIMIT 100;\n` : "");
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="dbw-body">
          {tabs.map(t => {
            const c = connOf(t.connId);
            if (!c) return null;
            return t.kind === "table" ? (
              <TableView key={t.id} conn={c} database={t.database} schema={t.schema} table={t.table!} active={active && t.id === activeId} onDirty={d => setTabs(l => l.map(x => (x.id === t.id && !!x.dirty !== d ? { ...x, dirty: d } : x)))} />
            ) : (
              <QueryView
                key={t.id}
                conns={conns ?? []}
                init={{ connId: t.connId, database: t.database, schema: t.schema, sql: t.sql ?? "", savedId: t.savedId, name: t.savedId ? t.title : undefined }}
                active={active && t.id === activeId}
                onSaved={q => setTabs(l => l.map(x => (x.id === t.id ? { ...x, savedId: q.id, title: q.name } : x)))}
              />
            );
          })}
          {!tabs.length && (
            <div className="dbw-empty" data-testid="db-welcome">
              <span className="auto-empty-ico">
                <Icon name="database" size={30} />
              </span>
              <p>从左边展开连接，点一张表看数据</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
