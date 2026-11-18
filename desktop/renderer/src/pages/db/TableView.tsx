import { useEffect, useMemo, useRef, useState } from "react";
import { isWritableEnv, quoteIdent, type DbDialect, type DbQueryResult, type DbRowOp, type DbStructure } from "../../../../shared/db";
import type { Connection } from "../../../../shared/connections";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { download } from "../../lib/download";
import { cellText, isLossy, isNull, safeName, toCsv, toInsertSql, toJson } from "../../lib/sqlText";
import { buildOrder, buildWhere, type Cond, type SortKey } from "../../lib/filterSql";
import { DataGrid, type GridCol, type GridRow, type GridSort } from "./DataGrid";
import { newSort, OrderPanel, WherePanel } from "./FilterBuilder";

type Pending = Map<number, Record<string, string | null>>;
const SIZES = [50, 100, 200, 500, 1000];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 一张表：数据（可筛选 / 排序 / 分页 / 改行）和结构两个视图 */
export function TableView({ conn, database, schema, table, active, onDirty }: { conn: Connection; database?: string; schema?: string; table: string; active: boolean; onDirty: (dirty: boolean) => void }) {
  const dialect = conn.fields.dbType as DbDialect;
  const writable = isWritableEnv(conn.env);
  const ref = useMemo(() => ({ connectionId: conn.id, database, schema, table }), [conn.id, database, schema, table]);

  const dbName = database ?? conn.fields.database ?? "";
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<"data" | "structure">("data");
  const [st, setSt] = useState<DbStructure | null>(null);
  const [stErr, setStErr] = useState("");
  const [data, setData] = useState<DbQueryResult | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [gen, setGen] = useState(0);
  const [whereIn, setWhereIn] = useState("");
  const [orderIn, setOrderIn] = useState("");
  const [pop, setPop] = useState<"where" | "order" | null>(null);
  const [conds, setConds] = useState<Cond[]>([]);
  const [join, setJoin] = useState<"and" | "or">("and");
  const [sorts, setSorts] = useState<SortKey[]>([]);
  const [applied, setApplied] = useState({ where: "", orderBy: "" });
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(200);
  const [total, setTotal] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [changes, setChanges] = useState<Pending>(new Map());
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [inserted, setInserted] = useState<Array<Record<string, string | null>>>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [menu, setMenu] = useState(false);
  const seq = useRef(0);

  const cols = data?.columns ?? [];
  const n = data?.rows.length ?? 0;
  const stCol = (name: string) => st?.columns.find(c => c.name === name);
  const pkCols = useMemo(() => (st?.columns ?? []).filter(c => c.pk).map(c => c.name), [st]);
  const hasPk = pkCols.length > 0 && pkCols.every(p => cols.some(c => c.name === p));
  const canWrite = writable && !!st && !st.view;
  const changedCells = [...changes.values()].reduce((a, c) => a + Object.keys(c).length, 0);
  const pending = changedCells + deleted.size + inserted.length;

  useEffect(() => onDirty(pending > 0), [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearPending = () => {
    setChanges(new Map());
    setDeleted(new Set());
    setInserted([]);
    setPicked(new Set());
  };

  /** 有没提交的修改时，换页 / 刷新 / 换条件会丢掉它们，先问一声 */
  const guard = () => pending === 0 || window.confirm(`有 ${pending} 处修改还没提交，继续会丢掉它们。继续吗？`);

  const load = async (p: number, a: { where: string; orderBy: string }, sz = size) => {
    const my = ++seq.current;
    setLoading(true);
    setErr("");
    const r = await api.dbData({ ...ref, where: a.where, orderBy: a.orderBy, limit: sz, offset: p * sz });
    if (my !== seq.current) return;
    setLoading(false);
    if (r.ok) {
      setData(r.data);
      setPage(p);
      setApplied(a);
      setGen(g => g + 1);
      clearPending();
    } else setErr(r.error);
  };

  useEffect(() => {
    void load(0, { where: "", orderBy: "" });
    void api.dbStructure(ref).then(r => (r.ok ? (setSt(r.data), setStErr("")) : setStErr(r.error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);

  const applyWith = (where: string, orderBy: string) => {
    if (!guard()) return;
    setMsg(null);
    setTotal(null);
    void load(0, { where: where.trim(), orderBy: orderBy.trim() });
  };
  const apply = () => applyWith(whereIn, orderIn);

  // 筛选 / 排序的可视化面板
  const fbCols = (st ? st.columns : cols.map(c => ({ name: c.name, dataType: c.dataType }))).map(c => ({ name: c.name, type: c.dataType }));
  const fbTypes = useMemo(() => Object.fromEntries(fbCols.map(c => [c.name, c.type])), [st, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const applyWhereBuilder = () => {
    const w = buildWhere(dialect, conds, fbTypes, join);
    setWhereIn(w);
    setPop(null);
    applyWith(w, orderIn);
  };
  const applyOrderBuilder = () => {
    const o = buildOrder(dialect, sorts);
    setOrderIn(o);
    setPop(null);
    applyWith(whereIn, o);
  };
  const refresh = () => {
    if (!guard()) return;
    setMsg(null);
    void load(page, applied);
  };
  const go = (p: number) => {
    if (!guard()) return;
    setMsg(null);
    void load(p, applied);
  };

  // ───── 排序：点表头在「升序 → 降序 → 不排序」之间切 ─────
  const sort: GridSort | null = useMemo(() => {
    for (const c of cols) {
      const m = new RegExp("^" + esc(quoteIdent(dialect, c.name)) + "\\s+(ASC|DESC)$", "i").exec(applied.orderBy.trim());
      if (m) return { col: c.name, dir: m[1].toLowerCase() as "asc" | "desc" };
    }
    return null;
  }, [cols, applied.orderBy, dialect]);
  const onSort = (col: string) => {
    if (!guard()) return;
    const next = sort?.col === col ? (sort.dir === "asc" ? `${quoteIdent(dialect, col)} DESC` : "") : `${quoteIdent(dialect, col)} ASC`;
    setOrderIn(next);
    setSorts(next ? [newSort(col, sort?.col === col ? "desc" : "asc")] : []);
    void load(0, { where: applied.where, orderBy: next });
  };

  // ───── 表格里的内容：原数据 + 待提交的修改 + 新增的行 ─────
  const gridCols: GridCol[] = cols.map(c => ({ name: c.name, type: stCol(c.name)?.dataType ?? c.dataType, pk: stCol(c.name)?.pk }));
  const gridRows: GridRow[] = useMemo(() => {
    const rows: GridRow[] = (data?.rows ?? []).map((cells, i) => {
      const ch = changes.get(i);
      return { cells: ch ? cells.map((v, ci) => (cols[ci].name in ch ? ch[cols[ci].name] : v)) : cells, state: deleted.has(i) ? "deleted" : undefined, changed: ch ? cols.map(c => c.name in ch) : undefined };
    });
    for (const vals of inserted) rows.push({ cells: cols.map(c => (c.name in vals ? vals[c.name] : null)), state: "inserted", unset: cols.map(c => !(c.name in vals)) });
    return rows;
  }, [data, changes, deleted, inserted, cols]);

  const canEdit = (r: number, c: number) => {
    if (!canWrite) return false;
    if (r >= n) return true;
    if (!hasPk || deleted.has(r)) return false;
    return !isLossy(data?.rows[r][c]);
  };

  const onEdit = (r: number, c: number, value: string | null) => {
    const name = cols[c].name;
    if (r >= n) {
      setInserted(list => list.map((v, i) => (i === r - n ? { ...v, [name]: value } : v)));
      return;
    }
    const orig = data!.rows[r][c];
    const same = isNull(orig) ? value === null : value === cellText(orig);
    setChanges(m => {
      const next = new Map(m);
      const row = { ...(next.get(r) ?? {}) };
      if (same) delete row[name];
      else row[name] = value;
      if (Object.keys(row).length) next.set(r, row);
      else next.delete(r);
      return next;
    });
  };

  const addRow = () => {
    setInserted(l => [...l, {}]);
    setMode("data");
  };
  const delRows = () => {
    const del = new Set(deleted);
    const dropIns = new Set<number>();
    for (const i of picked) (i < n ? del.add(i) : dropIns.add(i - n));
    setDeleted(del);
    if (dropIns.size) setInserted(l => l.filter((_, i) => !dropIns.has(i)));
    setPicked(new Set());
  };

  const commit = async () => {
    if (!data) return;
    const ops: DbRowOp[] = [];
    const keyOf = (i: number) => Object.fromEntries(pkCols.map(p => [p, data.rows[i][cols.findIndex(c => c.name === p)]]));
    for (const [i, vals] of changes) if (!deleted.has(i)) ops.push({ kind: "update", key: keyOf(i), values: vals });
    for (const i of deleted) ops.push({ kind: "delete", key: keyOf(i) });
    for (const vals of inserted) ops.push({ kind: "insert", values: vals });
    const nu = [...changes.keys()].filter(i => !deleted.has(i)).length;
    if (deleted.size && !window.confirm(`确定要删除 ${deleted.size} 行吗？提交后不能撤销。`)) return;
    setSaving(true);
    setMsg(null);
    const r = await api.dbApply({ ...ref, ops });
    setSaving(false);
    if (r.ok) {
      setMsg({ ok: true, text: `已提交：新增 ${inserted.length}、修改 ${nu}、删除 ${deleted.size} 行` });
      setTotal(null);
      void load(page, applied);
    } else setMsg({ ok: false, text: `提交失败，所有修改都没有生效：${r.error}` });
  };

  const countAll = async () => {
    setCounting(true);
    const r = await api.dbCount({ ...ref, where: applied.where });
    setCounting(false);
    if (r.ok) setTotal(r.data);
    else setMsg({ ok: false, text: `统计失败：${r.error}` });
  };

  // ───── 导出 ─────
  const doExport = async (fmt: "csv" | "json" | "sql", all: boolean) => {
    setMenu(false);
    let res: DbQueryResult | null = data;
    if (all) {
      setMsg({ ok: true, text: "正在取全部匹配的行…" });
      const r = await api.dbData({ ...ref, where: applied.where, orderBy: applied.orderBy, limit: 5000, offset: 0 });
      if (!r.ok) return setMsg({ ok: false, text: `导出失败：${r.error}` });
      res = r.data;
      setMsg({ ok: true, text: res.truncated || res.rows.length >= 5000 ? "已导出前 5000 行（行数太多，只取了这些）" : `已导出 ${res.rows.length} 行` });
    }
    if (!res) return;
    const base = safeName(table);
    if (fmt === "csv") download(`${base}.csv`, toCsv(res.columns, res.rows), "text/csv");
    else if (fmt === "json") download(`${base}.json`, toJson(res.columns, res.rows), "application/json");
    else download(`${base}.sql`, toInsertSql(dialect, table, res.columns, res.rows));
  };

  const from = page * size + 1;
  const to = page * size + n;
  const hasNext = n >= size;

  return (
    <div className="tv" data-testid="db-table-view" hidden={!active}>
      <div className="tv-crumb" data-testid="tv-crumb" title={`${conn.name} › ${dbName}${schema ? "." + schema : ""}.${table}`}>
        <Icon name="database" size={12} />
        <span data-testid="tv-crumb-conn">{conn.name}</span>
        <span className="tv-crumb-sep">›</span>
        <span data-testid="tv-crumb-scope">{dialect === "postgresql" && schema ? `${schema}@${dbName}` : dbName}</span>
        <span className="tv-crumb-sep">›</span>
        <b data-testid="tv-crumb-table">{table}</b>
        {st && <em>{st.columns.length} 字段</em>}
        <button
          className="tv-crumb-copy"
          data-testid="tv-crumb-copy"
          title="复制表名"
          onClick={() => void navigator.clipboard.writeText(dialect === "postgresql" && schema ? `${schema}.${table}` : table).then(() => (setCopied(true), window.setTimeout(() => setCopied(false), 1200)))}
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
        </button>
      </div>
      <div className="tv-bar">
        <div className="seg" role="tablist">
          <button className={mode === "data" ? "on" : ""} data-testid="tv-mode-data" onClick={() => (setMsg(null), setMode("data"))}>
            数据
          </button>
          <button className={mode === "structure" ? "on" : ""} data-testid="tv-mode-structure" onClick={() => (setMsg(null), setMode("structure"))}>
            结构
          </button>
        </div>
        <span className="spacer" />
        {!writable && (
          <span className="db-rw ro" title={`环境是「${conn.env}」，只读；只有开发 / 测试环境的库可以改数据`}>
            只读
          </span>
        )}
        <button className="btn sm" data-testid="tv-refresh" disabled={loading} onClick={refresh}>
          <Icon name="refresh" size={13} /> 刷新
        </button>
        {canWrite && (
          <>
            <button className="btn sm" data-testid="tv-add" onClick={addRow}>
              <Icon name="plus" size={13} /> 新增行
            </button>
            <button className="btn sm" data-testid="tv-del" disabled={!picked.size} onClick={delRows} title={picked.size ? "把选中的行标记为删除，提交后才真正删除" : "先点行号选中要删的行"}>
              <Icon name="trash" size={13} /> 删除行
            </button>
          </>
        )}
        <div className="tv-menu">
          <button className="btn sm" data-testid="tv-export" disabled={!data} onClick={() => setMenu(m => !m)}>
            <Icon name="download" size={13} /> 导出
          </button>
          {menu && (
            <div className="tv-pop" onMouseLeave={() => setMenu(false)}>
              <div className="tv-pop-h">当前页（{n} 行）</div>
              <button onClick={() => void doExport("csv", false)}>CSV</button>
              <button onClick={() => void doExport("json", false)}>JSON</button>
              <button onClick={() => void doExport("sql", false)}>INSERT 语句</button>
              <div className="tv-pop-h">全部匹配的行（最多 5000）</div>
              <button data-testid="tv-export-all-csv" onClick={() => void doExport("csv", true)}>CSV</button>
              <button onClick={() => void doExport("json", true)}>JSON</button>
              <button onClick={() => void doExport("sql", true)}>INSERT 语句</button>
            </div>
          )}
        </div>
      </div>

      {pending > 0 && (
        <div className="tv-pending" data-testid="tv-pending">
          <span>
            有 <b>{pending}</b> 处修改还没提交
            <em>
              （改 {changedCells} 格 · 新增 {inserted.length} 行 · 删除 {deleted.size} 行）
            </em>
          </span>
          <span className="spacer" />
          <button className="btn sm" disabled={saving} onClick={clearPending}>
            <Icon name="undo" size={13} /> 撤销
          </button>
          <button className="btn sm primary" data-testid="tv-commit" disabled={saving} onClick={() => void commit()}>
            <Icon name="check" size={13} /> {saving ? "提交中…" : "提交"}
          </button>
        </div>
      )}
      {msg && <div className={`tv-msg ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}
      {canWrite && data && !hasPk && mode === "data" && <div className="tv-msg warn">这张表没有主键，没法定位到某一行，所以只能新增行，不能改或删已有的行。</div>}
      {st?.view && <div className="tv-msg warn">这是视图，只能看。</div>}

      {mode === "data" ? (
        <>
          <div className="tv-filter">
            <div className="tv-f-wrap">
              <div className="tv-f">
                <button className={`tv-f-btn ${pop === "where" ? "on" : ""}`} data-popover-anchor data-testid="tv-filter-btn" title="用可视化条件筛选" onClick={() => setPop(p => (p === "where" ? null : "where"))}>
                  <Icon name="filter" size={13} />
                </button>
                <span>WHERE</span>
                <input data-testid="tv-where" value={whereIn} placeholder="条件，如 id > 100 AND name LIKE 'a%'" spellCheck={false} onChange={e => setWhereIn(e.target.value)} onKeyDown={e => e.key === "Enter" && apply()} />
                <button className="tv-f-btn" data-popover-anchor title="展开筛选条件" onClick={() => setPop(p => (p === "where" ? null : "where"))}>
                  <Icon name="down" size={12} />
                </button>
              </div>
              {pop === "where" && (
                <WherePanel
                  columns={fbCols}
                  conds={conds}
                  join={join}
                  onChange={setConds}
                  onJoin={setJoin}
                  onApply={applyWhereBuilder}
                  onClear={() => {
                    setConds([]);
                    setWhereIn("");
                    setPop(null);
                    applyWith("", orderIn);
                  }}
                  onClose={() => setPop(null)}
                />
              )}
            </div>
            <div className="tv-f-wrap">
              <div className="tv-f">
                <button className={`tv-f-btn ${pop === "order" ? "on" : ""}`} data-popover-anchor data-testid="tv-sort-btn" title="用可视化方式排序" onClick={() => setPop(p => (p === "order" ? null : "order"))}>
                  <Icon name="sort" size={13} />
                </button>
                <span className="ord">ORDER BY</span>
                <input data-testid="tv-order" value={orderIn} placeholder="排序，如 created_at DESC" spellCheck={false} onChange={e => setOrderIn(e.target.value)} onKeyDown={e => e.key === "Enter" && apply()} />
                <button className="tv-f-btn" data-popover-anchor title="展开排序" onClick={() => setPop(p => (p === "order" ? null : "order"))}>
                  <Icon name="down" size={12} />
                </button>
              </div>
              {pop === "order" && (
                <OrderPanel
                  columns={fbCols}
                  sorts={sorts}
                  onChange={setSorts}
                  onApply={applyOrderBuilder}
                  onClear={() => {
                    setSorts([]);
                    setOrderIn("");
                    setPop(null);
                    applyWith(whereIn, "");
                  }}
                  onClose={() => setPop(null)}
                />
              )}
            </div>
            <button className="btn sm primary" data-testid="tv-apply" disabled={loading} onClick={apply}>
              <Icon name="play" size={11} /> 应用
            </button>
          </div>
          {err ? (
            <div className="tv-err" data-testid="tv-err">
              {err}
            </div>
          ) : (
            <DataGrid
              testid="tv-grid"
              columns={gridCols}
              rows={gridRows}
              rowStart={page * size}
              sort={sort}
              onSort={onSort}
              selected={picked}
              onToggleRow={canWrite ? i => setPicked(s => (s.has(i) ? new Set([...s].filter(x => x !== i)) : new Set(s).add(i))) : undefined}
              canEdit={canEdit}
              onEdit={onEdit}
              resetKey={gen}
              empty={loading ? "加载中…" : "没有符合条件的数据"}
            />
          )}
          <div className="tv-foot">
            <span data-testid="tv-range">{n ? `第 ${from}–${to} 行` : "0 行"}</span>
            {total !== null ? (
              <span>共 {total} 行</span>
            ) : (
              <button className="link-btn" disabled={counting} onClick={() => void countAll()}>
                {counting ? "统计中…" : "统计总数"}
              </button>
            )}
            {data && <span className="dim">{data.elapsedMs} ms</span>}
            {loading && <span className="spinner" />}
            <span className="spacer" />
            <select
              value={size}
              title="每页行数"
              onChange={e => {
                const sz = Number(e.target.value);
                if (!guard()) return;
                setSize(sz);
                void load(0, applied, sz);
              }}
            >
              {SIZES.map(s => (
                <option key={s} value={s}>
                  {s} 行/页
                </option>
              ))}
            </select>
            <button className="btn sm" data-testid="tv-prev" disabled={page === 0 || loading} onClick={() => go(page - 1)}>
              上一页
            </button>
            <button className="btn sm" data-testid="tv-next" disabled={!hasNext || loading} onClick={() => go(page + 1)}>
              下一页
            </button>
          </div>
        </>
      ) : (
        <Structure st={st} err={stErr} />
      )}
    </div>
  );
}

function Structure({ st, err }: { st: DbStructure | null; err: string }) {
  if (err) return <div className="tv-err">{err}</div>;
  if (!st) return <div className="dg-empty">加载中…</div>;
  return (
    <div className="st" data-testid="tv-structure">
      <table className="st-table st-cols">
        <thead>
          <tr>
            <th>#</th>
            <th>字段</th>
            <th>类型</th>
            <th>可空</th>
            <th>默认值</th>
            <th>主键</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {st.columns.map((c, i) => (
            <tr key={c.name}>
              <td className="dim">{i + 1}</td>
              <td className="mono">{c.name}</td>
              <td className="mono">
                {c.dataType}
                {c.extra ? <em> {c.extra}</em> : null}
              </td>
              <td>{c.nullable ? "是" : "否"}</td>
              <td className="mono">{c.default ?? ""}</td>
              <td>{c.pk ? <span className="dg-key">PK</span> : ""}</td>
              <td>{c.comment}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>索引</h4>
      {st.indexes.length ? (
        <table className="st-table st-idx">
          <thead>
            <tr>
              <th>名称</th>
              <th>字段</th>
              <th>类型</th>
              <th>唯一</th>
            </tr>
          </thead>
          <tbody>
            {st.indexes.map(x => (
              <tr key={x.name}>
                <td className="mono">
                  {x.name}
                  {x.primary && <span className="dg-key">PK</span>}
                </td>
                <td className="mono">{x.columns}</td>
                <td>{x.method}</td>
                <td>{x.unique ? "是" : "否"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="dim">没有索引</p>
      )}
    </div>
  );
}
