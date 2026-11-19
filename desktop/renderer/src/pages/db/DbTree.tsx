import { useCallback, useEffect, useRef, useState } from "react";
import { isWritableEnv, quoteIdent, type DbDialect, type DbEventTrigger, type DbExtension, type DbResp, type DbSchemaInfo, type DbStructure, type DbTableInfo } from "../../../../shared/db";
import type { Connection } from "../../../../shared/connections";
import { api } from "../../api";
import { Icon, type IconName } from "../../components/Icon";
import { download } from "../../lib/download";
import { listQueries, onQueriesChanged, removeQuery, type SavedQuery } from "../../lib/savedQueries";
import { safeName, toCsv, toInsertSql, toJson } from "../../lib/sqlText";

type Node<T> = { st: "loading" | "ok" | "err"; data?: T; err?: string };

/** 右键菜单的一项：有 sub 就是子菜单 */
interface MItem {
  label?: string;
  icon?: IconName;
  kbd?: string[];
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  testid?: string;
  sep?: boolean;
  sub?: MItem[];
  run?: () => void;
}

/** 菜单里的一列（子菜单是嵌套的一列）：鼠标移到带 sub 的项上，右边（放不下就左边）弹出它的子菜单 */
function MenuList({ items, onDone, flip }: { items: MItem[]; onDone: () => void; flip: boolean }) {
  const [hot, setHot] = useState(-1);
  return (
    <>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="dt-menu-sep" />
        ) : (
          <div key={i} className="dt-menu-row" onMouseEnter={() => setHot(it.sub && !it.disabled ? i : -1)}>
            <button
              className={`dt-menu-item ${it.danger ? "danger" : ""}`}
              data-testid={it.testid}
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                if (it.sub) return setHot(i);
                onDone();
                it.run?.();
              }}
            >
              {it.icon ? <Icon name={it.icon} size={14} /> : <span className="dt-menu-noico" />}
              <span>{it.label}</span>
              {it.kbd?.map(k => <kbd key={k}>{k}</kbd>)}
              {it.sub && <Icon name="right" size={12} />}
            </button>
            {it.sub && hot === i && (
              <div className="dt-menu dt-sub" style={flip ? { right: "calc(100% + 2px)" } : { left: "calc(100% + 2px)" }}>
                <MenuList items={it.sub} onDone={onDone} flip={flip} />
              </div>
            )}
          </div>
        ),
      )}
    </>
  );
}

const PIN_KEY = "harness.db.pins";
const readPins = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

const envCls = (env: string) => (env === "生产" ? "prod" : env === "预发" ? "pre" : env === "测试" ? "test" : env === "开发" ? "dev" : "");

/** 树里点中的位置：哪个连接、哪个库、哪个 schema（没点到的层为空） */
interface Place {
  c: Connection;
  db?: string;
  schema?: string;
  /** 点的是一张表 / 视图：name 是表名；tdb、tschema 是树里打开这张表用的位置（MySQL 的库名放在 tschema 里） */
  tbl?: { name: string; kind: string; tdb?: string; tschema?: string };
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
  onTable: (c: Connection, database: string | undefined, schema: string | undefined, table: string, o?: { newTab?: boolean; structure?: boolean }) => void;
  onQuery: (c: Connection, database?: string, schema?: string, sql?: string) => void;
  /** 打开这个位置的「默认查询」：已经开着就切过去，没有就新开一个 */
  onDefaultQuery: (c: Connection, database?: string, schema?: string) => void;
  onOpenSaved: (q: SavedQuery) => void;
  onManage: () => void;
}) {
  // 右键菜单（新建查询 / 打开默认查询 / 粘贴 SQL）：对着连接、库、schema、「查询」都能点
  const [menu, setMenu] = useState<{ x: number; y: number; at: Place } | null>(null);
  const [clip, setClip] = useState(false);
  const [pins, setPins] = useState<Set<string>>(readPins);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
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
      // 只把 schema 列出来，不替用户展开：点哪个才展开哪个
      await fetchInto(`s:${c.id}|${db}`, setSchemas, () => api.dbSchemas({ connectionId: c.id, database: db }));
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
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
    const h = at.tbl ? 330 : 130;
    setMenu({ x: Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_W - 8)), y: Math.max(4, Math.min(e.clientY, window.innerHeight - h)), at });
  };

  const say = (ok: boolean, text: string) => {
    setFlash({ ok, text });
    window.setTimeout(() => setFlash(f => (f && f.text === text ? null : f)), 4000);
  };
  const copyText = (text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(
      () => say(true, `已复制${what}`),
      () => say(false, "复制失败：没有剪贴板权限"),
    );
  };
  const togglePin = (key: string) => {
    setPins(old => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem(PIN_KEY, JSON.stringify([...next]));
      } catch {
        /* 存不了就只在这次有效 */
      }
      return next;
    });
  };

  /** 表 / 视图的右键菜单：看数据、看结构、复制、导出、生成 SQL、危险操作。会改数据的只生成 SQL 放进新查询页，不会替你执行 */
  const tableItems = (at: Place): MItem[] => {
    const t = at.tbl!;
    const c = at.c;
    const dialect: DbDialect = c.fields.dbType === "postgresql" ? "postgresql" : "mysql";
    const qi = (s: string) => quoteIdent(dialect, s);
    const s = scopeOf(at);
    const isPg = dialect === "postgresql";
    const view = t.kind === "view";
    const ref = { connectionId: c.id, database: t.tdb, schema: t.tschema, table: t.name };
    const name = isPg ? `${qi(s.schema ?? "public")}.${qi(t.name)}` : qi(t.name);
    const full = isPg ? name : `${qi(s.db ?? t.tschema ?? "")}.${qi(t.name)}`;
    const pinKey = `${c.id}|${t.tdb ?? ""}|${t.tschema ?? ""}|${t.name}`;
    const writable = isWritableEnv(c.env);
    const lockTip = writable ? undefined : "当前连接是只读环境，不能改数据";

    const inQuery = (sql: string) => onQuery(c, s.db, s.schema, sql);
    const structure = async (): Promise<DbStructure | null> => {
      const r = await api.dbStructure(ref);
      if (!r.ok) {
        say(false, `读取表结构失败：${r.error}`);
        return null;
      }
      return r.data;
    };
    const withCols = (fn: (cols: string[], pk: string[]) => string) => async () => {
      const st = await structure();
      if (st) inQuery(fn(st.columns.map(x => x.name), st.columns.filter(x => x.pk).map(x => x.name)));
    };
    const where = (pk: string[]) => (pk.length ? pk.map(p => `${qi(p)} = NULL`).join(" AND ") : "1 = 0 /* 补上条件 */");
    const exportRows = (fmt: "csv" | "json" | "sql") => async () => {
      say(true, "正在取数据…");
      const r = await api.dbData({ ...ref, limit: 5000, offset: 0 });
      if (!r.ok) return say(false, `导出失败：${r.error}`);
      const d = r.data;
      const base = safeName(t.name);
      if (fmt === "csv") download(`${base}.csv`, toCsv(d.columns, d.rows), "text/csv");
      else if (fmt === "json") download(`${base}.json`, toJson(d.columns, d.rows), "application/json");
      else download(`${base}.sql`, toInsertSql(dialect, t.name, d.columns, d.rows));
      say(true, d.truncated || d.rows.length >= 5000 ? "已导出前 5000 行（行数太多，只取了这些）" : `已导出 ${d.rows.length} 行`);
    };

    return [
      { label: "查看数据", icon: "grid", testid: "dt-tm-open", run: () => onTable(c, t.tdb, t.tschema, t.name) },
      { label: "新标签页查看", icon: "panel", kbd: ["Alt"], testid: "dt-tm-newtab", run: () => onTable(c, t.tdb, t.tschema, t.name, { newTab: true }) },
      { label: "查看表结构", icon: "list", testid: "dt-tm-structure", run: () => onTable(c, t.tdb, t.tschema, t.name, { structure: true }) },
      { label: "新建查询", icon: "plus", testid: "dt-tm-query", run: () => inQuery(`SELECT * FROM ${name}\nLIMIT 100;\n`) },
      { label: "刷新", icon: "refresh", testid: "dt-tm-refresh", run: () => void loadTables(c, t.tdb, t.tschema) },
      { label: pins.has(pinKey) ? "取消置顶" : "置顶", icon: "check", testid: "dt-tm-pin", run: () => togglePin(pinKey) },
      { sep: true },
      {
        label: "复制",
        icon: "copy",
        sub: [
          { label: "表名", run: () => copyText(t.name, "表名") },
          { label: "完整表名", run: () => copyText(full, "完整表名") },
          { label: "SELECT 语句", run: () => copyText(`SELECT * FROM ${name};`, " SELECT 语句".trim()) },
          {
            label: "字段名",
            run: async () => {
              const st = await structure();
              if (st) copyText(st.columns.map(x => x.name).join(", "), "字段名");
            },
          },
          {
            label: "建表语句（字段清单）",
            run: async () => {
              const st = await structure();
              if (!st) return;
              const lines = st.columns.map(x => `  ${qi(x.name)} ${x.dataType}${x.nullable ? "" : " NOT NULL"}${x.default !== null && x.default !== undefined ? ` DEFAULT ${x.default}` : ""}`);
              const pk = st.columns.filter(x => x.pk).map(x => qi(x.name));
              if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
              copyText(`CREATE TABLE ${name} (\n${lines.join(",\n")}\n);`, "建表语句（只含字段和主键，不含索引等）");
            },
          },
        ],
      },
      {
        label: "数据工具",
        icon: "download",
        sub: [
          { label: "导出 CSV（前 5000 行）", testid: "dt-tm-csv", run: exportRows("csv") },
          { label: "导出 JSON（前 5000 行）", run: exportRows("json") },
          { label: "导出 INSERT（前 5000 行）", run: exportRows("sql") },
          {
            label: "统计行数",
            run: async () => {
              const r = await api.dbCount(ref);
              say(r.ok, r.ok ? `${t.name}：共 ${r.data} 行` : `统计失败：${r.error}`);
            },
          },
        ],
      },
      {
        label: "SQL 与代码",
        icon: "terminal",
        sub: [
          { label: "SELECT（列出全部字段）", run: withCols(cols => `SELECT\n${cols.map(x => `  ${qi(x)}`).join(",\n")}\nFROM ${name}\nLIMIT 100;\n`) },
          { label: "INSERT 模板", disabled: view, run: withCols(cols => `INSERT INTO ${name} (${cols.map(qi).join(", ")})\nVALUES (\n${cols.map((x, i) => `  NULL${i < cols.length - 1 ? "," : ""} -- ${x}`).join("\n")}\n);\n`) },
          { label: "UPDATE 模板", disabled: view, run: withCols((cols, pk) => `UPDATE ${name}\nSET ${cols.filter(x => !pk.includes(x)).map(x => `${qi(x)} = NULL`).join(",\n    ") || `${qi(cols[0] ?? "col")} = NULL`}\nWHERE ${where(pk)};\n`) },
          { label: "DELETE 模板", disabled: view, run: withCols((_cols, pk) => `DELETE FROM ${name}\nWHERE ${where(pk)};\n`) },
        ],
      },
      {
        label: "表管理",
        icon: "box",
        sub: [
          { label: "重命名（生成 SQL）", disabled: view || !writable, title: lockTip, run: () => inQuery(`ALTER TABLE ${name} RENAME TO ${qi("new_name")};\n`) },
          {
            label: "复制表（生成 SQL）",
            disabled: view || !writable,
            title: lockTip,
            run: () => {
              const copy = isPg ? `${qi(s.schema ?? "public")}.${qi(`${t.name}_copy`)}` : qi(`${t.name}_copy`);
              inQuery(isPg ? `CREATE TABLE ${copy} (LIKE ${name} INCLUDING ALL);\nINSERT INTO ${copy} SELECT * FROM ${name};\n` : `CREATE TABLE ${copy} LIKE ${name};\nINSERT INTO ${copy} SELECT * FROM ${name};\n`);
            },
          },
        ],
      },
      { sep: true },
      {
        label: "危险操作",
        icon: "alert",
        danger: true,
        sub: [
          { label: "清空表（生成 TRUNCATE）", danger: true, disabled: view || !writable, title: lockTip ?? "只生成语句放进新查询页，不会直接执行", run: () => inQuery(`TRUNCATE TABLE ${name};\n`) },
          { label: view ? "删除视图（生成 DROP）" : "删除表（生成 DROP）", danger: true, disabled: !writable, title: lockTip ?? "只生成语句放进新查询页，不会直接执行", run: () => inQuery(`DROP ${view ? "VIEW" : "TABLE"} ${name};\n`) },
        ],
      },
    ];
  };

  const placeItems = (at: Place): MItem[] => [
    { label: "新建查询", icon: "plus", kbd: ["Ctrl", "T"], testid: "dt-menu-new", run: () => doNew(at) },
    { label: "打开默认查询", icon: "terminal", kbd: ["Ctrl", "↵"], testid: "dt-menu-default", run: () => doDefault(at) },
    { sep: true },
    { label: "粘贴 SQL", icon: "copy", kbd: ["Ctrl", "V"], disabled: !clip, title: clip ? undefined : "剪贴板里没有文字", testid: "dt-menu-paste", run: () => void doPaste(at) },
  ];
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
    const pinKey = (name: string) => `${c.id}|${db ?? ""}|${schema ?? ""}|${name}`;
    const list = (n.data ?? []).filter(t => !q || t.name.toLowerCase().includes(q)).sort((a, b) => Number(pins.has(pinKey(b.name))) - Number(pins.has(pinKey(a.name))));
    if (!list.length) return <div className={`dt-row dim d${depth}`}>{q ? "没有匹配的表" : "没有表"}</div>;
    return list.map(t => {
      const key = pinKey(t.name);
      // MySQL 的树里库名放在 schema 这一格；做 SQL 时要换回「库」
      const here: Place = { c, db: c.fields.dbType === "postgresql" ? db : schema, schema: c.fields.dbType === "postgresql" ? schema : undefined, tbl: { name: t.name, kind: t.kind, tdb: db, tschema: schema } };
      return (
        <div key={t.name} className={`dt-row d${depth} tbl ${activeKey === key ? "active" : ""}`} data-testid="dt-table" data-table={t.name} title={t.comment ? `${t.name} — ${t.comment}` : t.name} onClick={e => (setSel({ c, db, schema }), onTable(c, db, schema, t.name, e.altKey ? { newTab: true } : undefined))} onContextMenu={e => openMenu(e, here)}>
          <span className={`dt-ico k-${t.kind}`}>
            <Icon name={t.kind === "view" ? "eye" : "grid"} size={13} />
          </span>
          <span className="dt-name">{t.name}</span>
          {pins.has(key) && <span className="dt-pin" title="已置顶">●</span>}
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

  /** 每个库下面最后一项「查询」：这个库里保存的查询；右键新建查询 / 打开默认查询 / 粘贴 SQL（没记库的老查询算在连接的默认库里） */
  const renderQueries = (c: Connection, db: string) => {
    const qk = `q:${c.id}|${db}`;
    const qOpen = open.has(qk);
    const mine = saved.filter(s => s.connId === c.id && (s.database ?? c.fields.database ?? "") === db);
    return (
      <div key={qk}>
        <div className="dt-row d2 group" data-testid="dt-queries" onClick={() => (setSel({ c, db }), expand(qk, !qOpen))} onContextMenu={e => openMenu(e, { c, db })}>
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
              <div key={s.id} className={`dt-row d3 saved ${activeSaved === s.id ? "active" : ""}`} data-testid="dt-saved" title={s.sql.slice(0, 300)} onClick={() => onOpenSaved(s)} onContextMenu={e => openMenu(e, { c, db })}>
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
            <div className="dt-row dim d3">还没有保存的查询：在查询页点「保存」</div>
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
                                {renderQueries(c, db)}
                              </>
                            ) : (
                              <>
                                {renderTables(c, undefined, db, 2)}
                                {renderQueries(c, db)}
                              </>
                            ))}
                        </div>
                      );
                    })}
                </>
              )}
            </div>
          );
        })}
      </div>
      {flash && (
        <div className={`dt-flash ${flash.ok ? "" : "bad"}`} data-testid="dt-flash">
          {flash.text}
        </div>
      )}
      {menu && (
        <div className="dt-menu" data-testid={menu.at.tbl ? "dt-table-menu" : "dt-menu"} style={{ left: menu.x, top: menu.y, width: MENU_W }} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
          <MenuList items={menu.at.tbl ? tableItems(menu.at) : placeItems(menu.at)} onDone={() => setMenu(null)} flip={menu.x + MENU_W + 200 > window.innerWidth} />
        </div>
      )}
    </aside>
  );
}
