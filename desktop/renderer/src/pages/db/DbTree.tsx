import { useCallback, useEffect, useRef, useState } from "react";
import { isWritableEnv, type DbEventTrigger, type DbExtension, type DbResp, type DbSchemaInfo, type DbTableInfo } from "../../../../shared/db";
import type { Connection } from "../../../../shared/connections";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { listQueries, onQueriesChanged, removeQuery, type SavedQuery } from "../../lib/savedQueries";

type Node<T> = { st: "loading" | "ok" | "err"; data?: T; err?: string };

const envCls = (env: string) => (env === "生产" ? "prod" : env === "预发" ? "pre" : env === "测试" ? "test" : env === "开发" ? "dev" : "");

/** 树里点中的位置：哪个连接、哪个库、哪个 schema（没点到的层为空） */
interface Place {
  c: Connection;
  db?: string;
  schema?: string;
}

/** 位置补全：库缺省用连接里配的默认库，PostgreSQL 的 schema 缺省 public，MySQL 没有 schema */
const scopeOf = (p: Place): { db?: string; schema?: string } => ({ db: p.db ?? (p.c.fields.database || undefined), schema: p.c.fields.dbType === "postgresql" ? (p.schema ?? "public") : undefined });

const MENU_W = 220;

const compact = (n?: number | null) => (n === null || n === undefined ? "" : n >= 1e8 ? `${(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : String(n));

/** 左侧连接树：连接 → 库 →（PostgreSQL：schema / 扩展 / 事件触发器）→ 表和视图；最后是保存的「查询」。展开时才去取 */
export function DbTree({
  conns,
  version,
  activeKey,
  activeSaved,
  onTable,
  onQuery,
  onDefaultQuery,
  onOpenSaved,
  onManage,
}: {
  conns: Connection[];
  /** 连接设置变了就换一个值，树会清空重来 */
  version: number;
  activeKey: string | null;
  activeSaved: string | null;
  onTable: (c: Connection, database: string | undefined, schema: string | undefined, table: string) => void;
  onQuery: (c: Connection, database?: string, schema?: string, sql?: string) => void;
  /** 打开这个位置的「默认查询」：已经开着就切过去，没有就新开一个 */
  onDefaultQuery: (c: Connection, database?: string, schema?: string) => void;
  onOpenSaved: (q: SavedQuery) => void;
  onManage: () => void;
}) {
  // 右键菜单（新建查询 / 打开默认查询 / 粘贴 SQL）：对着连接、库、schema、「查询」都能点
  const [menu, setMenu] = useState<{ x: number; y: number; at: Place } | null>(null);
  const [clip, setClip] = useState(false);
  const [sel, setSel] = useState<Place | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dbs, setDbs] = useState<Record<string, Node<string[]>>>({});
  const [schemas, setSchemas] = useState<Record<string, Node<DbSchemaInfo[]>>>({});
  const [tables, setTables] = useState<Record<string, Node<DbTableInfo[]>>>({});
  const [exts, setExts] = useState<Record<string, Node<DbExtension[]>>>({});
  const [evts, setEvts] = useState<Record<string, Node<DbEventTrigger[]>>>({});
  const [saved, setSaved] = useState<SavedQuery[]>(listQueries);
  const [filter, setFilter] = useState("");
  const started = useRef(new Set<string>());

  useEffect(() => onQueriesChanged(() => setSaved(listQueries())), []);

  useEffect(() => {
    setOpen(new Set());
    setDbs({});
    setSchemas({});
    setTables({});
    setExts({});
    setEvts({});
    started.current = new Set();
  }, [version]);

  const fetchInto = async <T,>(key: string, set: React.Dispatch<React.SetStateAction<Record<string, Node<T>>>>, call: () => Promise<DbResp<T>>): Promise<T | undefined> => {
    set(m => ({ ...m, [key]: { st: "loading" } }));
    const r = await call();
    set(m => ({ ...m, [key]: r.ok ? { st: "ok", data: r.data } : { st: "err", err: r.error } }));
    return r.ok ? r.data : undefined;
  };

  const expand = useCallback((key: string, on = true) => setOpen(s => (on ? new Set(s).add(key) : new Set([...s].filter(k => k !== key)))), []);

  const loadTables = useCallback((c: Connection, db: string | undefined, schema: string | undefined) => fetchInto(`t:${c.id}|${db ?? ""}|${schema ?? ""}`, setTables, () => api.dbTables({ connectionId: c.id, database: db, schema })), []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSchemas = useCallback(
    async (c: Connection, db: string) => {
      const list = await fetchInto(`s:${c.id}|${db}`, setSchemas, () => api.dbSchemas({ connectionId: c.id, database: db }));
      if (list?.some(s => s.name === "public")) {
        expand(`sc:${c.id}|${db}|public`);
        void loadTables(c, db, "public");
      }
    },
    [expand, loadTables], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const openDb = useCallback(
    (c: Connection, db: string) => {
      expand(`d:${c.id}|${db}`);
      if (c.fields.dbType === "postgresql") void loadSchemas(c, db);
      else void loadTables(c, undefined, db);
    },
    [expand, loadSchemas, loadTables],
  );

  const loadDbs = useCallback(
    async (c: Connection) => {
      const list = await fetchInto(`c:${c.id}`, setDbs, () => api.dbDatabases(c.id));
      const def = c.fields.database;
      if (list && def && list.includes(def)) openDb(c, def);
    },
    [openDb], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const toggleConn = (c: Connection) => {
    const key = `c:${c.id}`;
    if (open.has(key)) return expand(key, false);
    expand(key);
    if (!started.current.has(key)) {
      started.current.add(key);
      void loadDbs(c);
    }
  };
  const reloadConn = (c: Connection) => {
    const drop = <T,>(p: string) => (m: Record<string, Node<T>>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(p)));
    setSchemas(drop(`s:${c.id}|`));
    setTables(drop(`t:${c.id}|`));
    setExts(drop(`x:${c.id}|`));
    setEvts(drop(`e:${c.id}|`));
    started.current.add(`c:${c.id}`);
    expand(`c:${c.id}`);
    void loadDbs(c);
  };

  const q = filter.trim().toLowerCase();

  const readClip = async (): Promise<string> => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  };
  const openMenu = (e: React.MouseEvent, at: Place) => {
    e.preventDefault();
    e.stopPropagation();
    setSel(at);
    void readClip().then(t => setClip(!!t.trim()));
    setMenu({ x: Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_W - 8)), y: Math.max(4, Math.min(e.clientY, window.innerHeight - 130)), at });
  };
  const doNew = (at: Place) => {
    const s = scopeOf(at);
    onQuery(at.c, s.db, s.schema);
  };
  const doDefault = (at: Place) => {
    const s = scopeOf(at);
    onDefaultQuery(at.c, s.db, s.schema);
  };
  const doPaste = async (at: Place) => {
    const text = await readClip();
    if (!text.trim()) return;
    const s = scopeOf(at);
    onQuery(at.c, s.db, s.schema, text);
  };
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", close);
    document.addEventListener("contextmenu", close);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("contextmenu", close);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const renderTables = (c: Connection, db: string | undefined, schema: string | undefined, depth: number) => {
    const n = tables[`t:${c.id}|${db ?? ""}|${schema ?? ""}`];
    if (!n || n.st === "loading") return <div className={`dt-row dim d${depth}`}>加载中…</div>;
    if (n.st === "err")
      return (
        <div className={`dt-row bad d${depth}`} title={n.err}>
          {n.err}
        </div>
      );
    const list = (n.data ?? []).filter(t => !q || t.name.toLowerCase().includes(q));
    if (!list.length) return <div className={`dt-row dim d${depth}`}>{q ? "没有匹配的表" : "没有表"}</div>;
    return list.map(t => {
      const key = `${c.id}|${db ?? ""}|${schema ?? ""}|${t.name}`;
      return (
        <div key={t.name} className={`dt-row d${depth} tbl ${activeKey === key ? "active" : ""}`} data-testid="dt-table" data-table={t.name} title={t.comment ? `${t.name} — ${t.comment}` : t.name} onClick={() => (setSel({ c, db, schema }), onTable(c, db, schema, t.name))} onContextMenu={e => openMenu(e, { c, db, schema })}>
          <span className={`dt-ico k-${t.kind}`}>
            <Icon name={t.kind === "view" ? "eye" : "grid"} size={13} />
          </span>
          <span className="dt-name">{t.name}</span>
          <span className="dt-rows">{compact(t.rows)}</span>
        </div>
      );
    });
  };

  /** PostgreSQL 库下面的「扩展」「事件触发器」：只看，展开时才取 */
  const renderGroup = <T,>(c: Connection, db: string, kind: "x" | "e", label: string, icon: "plug" | "spark", cache: Record<string, Node<T[]>>, set: React.Dispatch<React.SetStateAction<Record<string, Node<T[]>>>>, call: () => Promise<DbResp<T[]>>, row: (item: T) => { name: string; hint?: string; title?: string }) => {
    const key = `${kind}:${c.id}|${db}`;
    const isOpen = open.has(key);
    const n = cache[key];
    return (
      <div key={key}>
        <div
          className="dt-row d2 group"
          data-testid={`dt-${kind === "x" ? "ext" : "evt"}`}
          onClick={() => {
            if (isOpen) return expand(key, false);
            expand(key);
            if (!n) void fetchInto(key, set, call);
          }}
        >
          <Icon name={isOpen ? "down" : "right"} size={12} />
          <span className="dt-ico k-group">
            <Icon name={icon} size={13} />
          </span>
          <span className="dt-name">{label}</span>
          {n?.st === "ok" && <span className="dt-rows">{n.data?.length}</span>}
        </div>
        {isOpen &&
          (!n || n.st === "loading" ? (
            <div className="dt-row dim d3">加载中…</div>
          ) : n.st === "err" ? (
            <div className="dt-row bad d3" title={n.err}>
              {n.err}
            </div>
          ) : !n.data?.length ? (
            <div className="dt-row dim d3">没有</div>
          ) : (
            n.data.map(item => {
              const r = row(item);
              return (
                <div key={r.name} className="dt-row d3 leaf" title={r.title ?? r.name}>
                  <span className="dt-name">{r.name}</span>
                  {r.hint && <span className="dt-rows">{r.hint}</span>}
                </div>
              );
            })
          ))}
      </div>
    );
  };

  return (
    <aside
      className="dt"
      data-testid="db-tree"
      tabIndex={-1}
      onKeyDown={e => {
        // 树获得焦点时的快捷键：Ctrl+T 新建查询、Ctrl+Enter 打开默认查询、Ctrl+V 把剪贴板里的 SQL 贴成新查询
        if (!sel || !(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).tagName === "INPUT") return;
        const k = e.key.toLowerCase();
        if (k === "t") (e.preventDefault(), doNew(sel));
        else if (e.key === "Enter") (e.preventDefault(), doDefault(sel));
        else if (k === "v") (e.preventDefault(), void doPaste(sel));
      }}
    >
      <div className="dt-head">
        <span>连接</span>
        <span className="spacer" />
        <button className="icon-btn" title="管理连接" onClick={onManage}>
          <Icon name="settings" size={14} />
        </button>
      </div>
      <div className="dt-search">
        <Icon name="search" size={13} />
        <input data-testid="dt-filter" value={filter} placeholder="过滤表名" spellCheck={false} onChange={e => setFilter(e.target.value)} />
      </div>
      <div className="dt-list">
        {conns.map(c => {
          const ck = `c:${c.id}`;
          const isOpen = open.has(ck);
          const dn = dbs[ck];
          const pg = c.fields.dbType === "postgresql";
          const mine = saved.filter(s => s.connId === c.id);
          const qk = `q:${c.id}`;
          const qOpen = open.has(qk);
          return (
            <div key={c.id} className="dt-conn" data-testid="dt-conn" data-id={c.id}>
              <div className={`dt-row d0 conn ${c.enabled ? "" : "off"}`} onClick={() => (setSel({ c }), c.enabled && toggleConn(c))} onContextMenu={e => c.enabled && openMenu(e, { c })} title={c.enabled ? `${c.name} · ${c.env}` : "这个连接已停用"}>
                <Icon name={isOpen ? "down" : "right"} size={12} />
                <span className="dt-ico db">
                  <Icon name="database" size={13} />
                </span>
                <span className="dt-name">{c.name}</span>
                <span className={`conn-env ${envCls(c.env)}`}>{c.env}</span>
                {!isWritableEnv(c.env) && (
                  <span className="dt-lock" title="只读：只能查询">
                    只读
                  </span>
                )}
                {dn?.st === "ok" && <span className="dt-dot ok" title="已连接" />}
                {dn?.st === "err" && <span className="dt-dot bad" title={dn.err} />}
                {dn?.st === "loading" && <span className="spinner" />}
                <span className="dt-acts">
                  <button
                    className="icon-btn"
                    title="刷新"
                    onClick={e => {
                      e.stopPropagation();
                      reloadConn(c);
                    }}
                  >
                    <Icon name="refresh" size={13} />
                  </button>
                </span>
              </div>
              {isOpen && (
                <>
                  {dn?.st === "err" && (
                    <div className="dt-row bad d1" title={dn.err}>
                      {dn.err}
                    </div>
                  )}
                  {dn?.st === "ok" &&
                    (dn.data ?? []).map(db => {
                      const dk = `d:${c.id}|${db}`;
                      const dOpen = open.has(dk);
                      const sn = schemas[`s:${c.id}|${db}`];
                      const isDefault = !!c.fields.database && c.fields.database === db;
                      return (
                        <div key={db}>
                          <div className="dt-row d1 db" data-testid="dt-db" data-db={db} onClick={() => (setSel({ c, db }), dOpen ? expand(dk, false) : openDb(c, db))} onContextMenu={e => openMenu(e, { c, db })}>
                            <Icon name={dOpen ? "down" : "right"} size={12} />
                            <span className="dt-ico folder">
                              <Icon name="folder" size={13} />
                            </span>
                            <span className="dt-name">{db}</span>
                            {isDefault && (
                              <span className="dt-default" data-testid="dt-default" title="连接里配置的默认库">
                                默认库
                              </span>
                            )}
                          </div>
                          {dOpen &&
                            (pg ? (
                              <>
                                {!sn || sn.st === "loading" ? (
                                  <div className="dt-row dim d2">加载中…</div>
                                ) : sn.st === "err" ? (
                                  <div className="dt-row bad d2" title={sn.err}>
                                    {sn.err}
                                  </div>
                                ) : (
                                  (sn.data ?? []).map(sc => {
                                    const sk = `sc:${c.id}|${db}|${sc.name}`;
                                    const sOpen = open.has(sk);
                                    return (
                                      <div key={sc.name}>
                                        <div
                                          className="dt-row d2 schema"
                                          data-testid="dt-schema"
                                          data-schema={sc.name}
                                          title={sc.comment ? `${sc.name} — ${sc.comment}` : sc.name}
                                          onContextMenu={e => openMenu(e, { c, db, schema: sc.name })}
                                          onClick={() => {
                                            setSel({ c, db, schema: sc.name });
                                            if (sOpen) return expand(sk, false);
                                            expand(sk);
                                            if (!tables[`t:${c.id}|${db}|${sc.name}`]) void loadTables(c, db, sc.name);
                                          }}
                                        >
                                          <Icon name={sOpen ? "down" : "right"} size={12} />
                                          <span className="dt-ico folder">
                                            <Icon name="folder" size={13} />
                                          </span>
                                          <span className="dt-name">{sc.name}</span>
                                          {sc.comment && <span className="dt-cmt">{sc.comment}</span>}
                                        </div>
                                        {sOpen && renderTables(c, db, sc.name, 3)}
                                      </div>
                                    );
                                  })
                                )}
                                {renderGroup(c, db, "x", "扩展", "plug", exts, setExts, () => api.dbExtensions({ connectionId: c.id, database: db }), (x: DbExtension) => ({ name: x.name, hint: x.version, title: x.comment ? `${x.name} ${x.version} — ${x.comment}` : `${x.name} ${x.version}` }))}
                                {renderGroup(c, db, "e", "事件触发器", "spark", evts, setEvts, () => api.dbEventTriggers({ connectionId: c.id, database: db }), (x: DbEventTrigger) => ({ name: x.name, hint: x.enabled ? x.event : `${x.event}（已停用）`, title: `${x.name} · ${x.event}${x.enabled ? "" : "（已停用）"}` }))}
                              </>
                            ) : (
                              renderTables(c, undefined, db, 2)
                            ))}
                        </div>
                      );
                    })}
                  <div>
                    <div className="dt-row d1 group" data-testid="dt-queries" onClick={() => (setSel({ c }), expand(qk, !qOpen))} onContextMenu={e => openMenu(e, { c })}>
                      <Icon name={qOpen ? "down" : "right"} size={12} />
                      <span className="dt-ico k-query">
                        <Icon name="folder" size={13} />
                      </span>
                      <span className="dt-name">查询</span>
                      {mine.length > 0 && <span className="dt-rows">{mine.length}</span>}
                    </div>
                    {qOpen &&
                      (mine.length ? (
                        mine.map(s => (
                          <div key={s.id} className={`dt-row d2 saved ${activeSaved === s.id ? "active" : ""}`} data-testid="dt-saved" title={s.sql.slice(0, 300)} onClick={() => onOpenSaved(s)}>
                            <span className="dt-ico k-query">
                              <Icon name="terminal" size={13} />
                            </span>
                            <span className="dt-name">{s.name}</span>
                            <span className="dt-acts">
                              <button
                                className="icon-btn"
                                title="删除这个查询"
                                data-testid="dt-saved-del"
                                onClick={e => {
                                  e.stopPropagation();
                                  if (window.confirm(`删除保存的查询「${s.name}」吗？`)) removeQuery(s.id);
                                }}
                              >
                                <Icon name="trash" size={13} />
                              </button>
                            </span>
                          </div>
                        ))
                      ) : (
                        <div className="dt-row dim d2">还没有保存的查询：在查询页点「保存」</div>
                      ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {menu && (
        <div className="dt-menu" data-testid="dt-menu" style={{ left: menu.x, top: menu.y, width: MENU_W }} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
          <button className="dt-menu-item" data-testid="dt-menu-new" onClick={() => (setMenu(null), doNew(menu.at))}>
            <Icon name="plus" size={14} />
            <span>新建查询</span>
            <kbd>Ctrl</kbd>
            <kbd>T</kbd>
          </button>
          <button className="dt-menu-item" data-testid="dt-menu-default" onClick={() => (setMenu(null), doDefault(menu.at))}>
            <Icon name="terminal" size={14} />
            <span>打开默认查询</span>
            <kbd>Ctrl</kbd>
            <kbd>↵</kbd>
          </button>
          <div className="dt-menu-sep" />
          <button className="dt-menu-item" data-testid="dt-menu-paste" disabled={!clip} title={clip ? "把剪贴板里的 SQL 贴成一个新查询" : "剪贴板里没有文字"} onClick={() => (setMenu(null), void doPaste(menu.at))}>
            <Icon name="copy" size={14} />
            <span>粘贴 SQL</span>
            <kbd>Ctrl</kbd>
            <kbd>V</kbd>
          </button>
        </div>
      )}
    </aside>
  );
}
