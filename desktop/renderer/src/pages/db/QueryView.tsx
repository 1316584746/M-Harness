import { useEffect, useMemo, useRef, useState } from "react";
import { isWritableEnv, type DbDialect, type DbQueryResult } from "../../../../shared/db";
import type { Connection } from "../../../../shared/connections";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { download } from "../../lib/download";
import { saveQuery, type SavedQuery } from "../../lib/savedQueries";
import { formatSql, isReadSql, splitStatements, statementAt, toCsv, toggleComment, toJson } from "../../lib/sqlText";
import { DataGrid } from "./DataGrid";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { useCompletionSource } from "./useCompletionSource";

export interface QueryInit {
  connId: string;
  database?: string;
  schema?: string;
  sql: string;
  /** 打开后马上运行一次 */
  autoRun?: boolean;
  /** 从「查询」里保存的某条打开的：再点保存就是更新它 */
  savedId?: string;
  name?: string;
}

/** SQL 编辑器标签：写 SQL、Ctrl+Enter 运行光标所在的那条（选中了就运行选中的），结果在下面的表格里 */
export function QueryView({ conns, init, active, onSaved }: { conns: Connection[]; init: QueryInit; active: boolean; onSaved: (q: SavedQuery) => void }) {
  const [savedId, setSavedId] = useState(init.savedId);
  const [name, setName] = useState(init.name ?? "");
  const [naming, setNaming] = useState(false);
  const [flash, setFlash] = useState("");
  const [connId, setConnId] = useState(init.connId);
  const conn = conns.find(c => c.id === connId) ?? conns[0];
  const dialect = conn?.fields.dbType as DbDialect | undefined;
  const writable = !!conn && isWritableEnv(conn.env);
  const [database, setDatabase] = useState(init.database ?? "");
  const [schema, setSchema] = useState(init.schema ?? (dialect === "postgresql" ? "public" : ""));
  const [dbs, setDbs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [sql, setSql] = useState(init.sql);
  const caret = useRef({ a: 0, b: 0 });
  const editor = useRef<SqlEditorHandle>(null);
  const [res, setRes] = useState<DbQueryResult | null>(null);
  const [err, setErr] = useState("");
  const [running, setRunning] = useState(false);
  const [editorH, setEditorH] = useState(240);
  const [gen, setGen] = useState(0);
  const [ran, setRan] = useState("");

  const dbName = database || conn?.fields.database || "";

  // 换了连接：重新取库列表，库名回到连接里配的默认库
  useEffect(() => {
    if (!conn) return;
    let live = true;
    void api.dbDatabases(conn.id).then(r => live && setDbs(r.ok ? r.data : []));
    return () => {
      live = false;
    };
  }, [conn?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!conn || dialect !== "postgresql") return setSchemas([]);
    let live = true;
    void api.dbSchemas({ connectionId: conn.id, database: dbName || undefined }).then(r => live && setSchemas(r.ok ? r.data.map(s => s.name) : []));
    return () => {
      live = false;
    };
  }, [conn?.id, dbName, dialect]); // eslint-disable-line react-hooks/exhaustive-deps

  const completion = useCompletionSource(conn, dbName, schema, schemas);

  const dbOptions = useMemo(() => (dbName && !dbs.includes(dbName) ? [dbName, ...dbs] : dbs), [dbs, dbName]);

  const scope = () => ({ connectionId: conn!.id, database: dbName || undefined, schema: dialect === "postgresql" && schema ? schema : undefined, maxRows: 1000 });

  /** 光标所在的那条；选中了就是选中的部分 */
  const current = () => {
    const [a, b] = editor.current?.selection() ?? [caret.current.a, caret.current.b];
    return (b > a ? sql.slice(a, b).trim() : "") || statementAt(sql, a);
  };

  /** 运行一条语句（行首的按钮、Ctrl+Enter 都走这里） */
  const runText = async (text: string, shown = text) => {
    if (!conn || running) return;
    if (!text) return setErr("没有可运行的语句");
    if (!isReadSql(text) && !window.confirm(`要在「${conn.name}」（${conn.env}）里执行这条语句吗？\n\n${text.slice(0, 300)}`)) return;
    setRunning(true);
    setErr("");
    const r = await api.dbQuery({ ...scope(), sql: text });
    setRunning(false);
    setRan(shown);
    if (r.ok) {
      setRes(r.data);
      setGen(g => g + 1);
    } else {
      setRes(null);
      setErr(r.error);
    }
  };
  const run = () => runText(current());

  /** 依次运行编辑器里的全部语句，出错就停；表格里显示最后一条的结果 */
  const runAll = async () => {
    if (!conn || running) return;
    const list = splitStatements(sql).map(s => s.text.trim());
    if (!list.length) return setErr("没有可运行的语句");
    if (list.some(s => !isReadSql(s)) && !window.confirm(`要在「${conn.name}」（${conn.env}）里依次执行这 ${list.length} 条语句吗？其中有会修改数据的语句。\n\n${list.map(s => s.replace(/\s+/g, " ").slice(0, 80)).slice(0, 8).join("\n")}${list.length > 8 ? "\n…" : ""}`)) return;
    setRunning(true);
    setErr("");
    let last: DbQueryResult | null = null;
    for (let i = 0; i < list.length; i++) {
      const r = await api.dbQuery({ ...scope(), sql: list[i] });
      if (!r.ok) {
        setRunning(false);
        setRes(null);
        setRan(list[i]);
        return setErr(`第 ${i + 1} 条语句出错（前面 ${i} 条已执行）：${r.error}`);
      }
      last = r.data;
    }
    setRunning(false);
    setRes(last);
    setRan(`共执行 ${list.length} 条语句，这是最后一条的结果`);
    setGen(g => g + 1);
  };

  // 从 AI 助手带过来的：打开就运行一次（一条就运行它，多条依次运行；会改数据的语句照样先确认）
  const autoRan = useRef(false);
  useEffect(() => {
    if (!init.autoRun || autoRan.current || !conn) return;
    autoRan.current = true;
    const n = splitStatements(init.sql).length;
    void (n > 1 ? runAll() : runText(init.sql.trim()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]);

  /** 看执行计划：在语句前加 EXPLAIN（不会真的执行它） */
  const explain = () => {
    const text = current().replace(/;\s*$/, "");
    if (!text) return setErr("没有可运行的语句");
    return runText(/^\s*explain\b/i.test(text) ? text : `EXPLAIN ${text}`, text);
  };

  const format = () => {
    const [a, b] = editor.current?.selection() ?? [0, 0];
    const part = b > a;
    const out = formatSql(part ? sql.slice(a, b) : sql);
    const next = part ? sql.slice(0, a) + out + sql.slice(b) : out;
    if (next === sql) return;
    editor.current?.replace(next, part ? a : 0, part ? a + out.length : 0);
  };

  const comment = () => {
    const [a, b] = editor.current?.selection() ?? [0, 0];
    const r = toggleComment(sql, a, b);
    editor.current?.replace(r.value, r.a, r.b);
  };

  const doSave = (nm: string) => {
    if (!conn) return;
    const q = saveQuery({ id: savedId, connId: conn.id, name: nm.trim() || "未命名查询", sql, database: dbName || undefined, schema: dialect === "postgresql" && schema ? schema : undefined });
    setSavedId(q.id);
    setName(q.name);
    setNaming(false);
    setFlash("已保存");
    setTimeout(() => setFlash(""), 2000);
    onSaved(q);
  };

  const splitDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = editorH;
    const move = (ev: PointerEvent) => setEditorH(Math.max(90, Math.min(700, Math.round(h0 + ev.clientY - y0))));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  if (!conn) return <div className="dg-empty" hidden={!active}>没有数据库连接</div>;

  return (
    <div className="qv" data-testid="db-query-view" hidden={!active}>
      <div className="qv-bar">
        <button className="qv-ib run" data-testid="qv-run" disabled={running} onClick={() => void run()} data-tip="运行光标所在的语句，或选中的部分（Ctrl + Enter）" aria-label="运行">
          <Icon name="play" size={14} />
        </button>
        <button className="qv-ib run" data-testid="qv-run-all" disabled={running} onClick={() => void runAll()} data-tip="依次运行全部语句，出错就停（Ctrl + Shift + Enter）" aria-label="运行全部">
          <Icon name="playAll" size={15} />
        </button>
        <button className="qv-ib" data-testid="qv-explain" disabled={running} onClick={() => void explain()} data-tip="查看执行计划（EXPLAIN，不会真的执行）" aria-label="执行计划">
          <Icon name="branch" size={15} />
        </button>
        <span className="qv-sep" />
        <button className="qv-ib" data-testid="qv-format" disabled={!sql.trim()} onClick={format} data-tip="格式化 SQL（有选中的就只格式化选中的部分）" aria-label="格式化">
          <Icon name="format" size={15} />
        </button>
        <button className="qv-ib" data-testid="qv-comment" onClick={comment} data-tip="注释 / 取消注释选中的行（Ctrl + /）" aria-label="注释">
          <Icon name="comment" size={15} />
        </button>
        <span className="qv-sep" />
        {naming ? (
          <span className="qv-name">
            <input
              autoFocus
              data-testid="qv-name"
              value={name}
              placeholder="给这个查询起个名字"
              spellCheck={false}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") doSave(name);
                else if (e.key === "Escape") setNaming(false);
              }}
            />
            <button className="btn sm primary" data-testid="qv-name-ok" onClick={() => doSave(name)}>
              保存
            </button>
            <button className="btn sm" onClick={() => setNaming(false)}>
              取消
            </button>
          </span>
        ) : (
          <button className="qv-ib" data-testid="qv-save" disabled={!sql.trim()} data-tip={savedId ? `更新已保存的查询「${name}」` : "保存到左边「查询」里"} aria-label="保存" onClick={() => (savedId ? doSave(name) : setNaming(true))}>
            <Icon name="save" size={15} />
          </button>
        )}
        {flash && <span className="qv-flash">{flash}</span>}
        <span className="spacer" />
        <select
          data-testid="qv-conn"
          value={conn.id}
          onChange={e => {
            const c = conns.find(x => x.id === e.target.value);
            setConnId(e.target.value);
            setDatabase("");
            setSchema(c?.fields.dbType === "postgresql" ? "public" : "");
          }}
        >
          {conns.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}（{c.env}）
            </option>
          ))}
        </select>
        <select data-testid="qv-db" value={dbName} onChange={e => setDatabase(e.target.value)} title="库">
          {dbName === "" && <option value="">（默认库）</option>}
          {dbOptions.map(d => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        {dialect === "postgresql" && (
          <select value={schema} onChange={e => setSchema(e.target.value)} title="schema（相当于 search_path）">
            {[...new Set([schema || "public", ...schemas])].map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <span className={`db-rw ${writable ? "rw" : "ro"}`} title={writable ? "开发 / 测试环境：可以执行写语句（INSERT / UPDATE / DELETE / DDL）" : `环境是「${conn.env}」，只读，只能查询`}>
          {writable ? "可读写" : "只读"}
        </span>
      </div>
      <div className="qv-editor" style={{ height: editorH }}>
        <SqlEditor
          ref={editor}
          testid="qv-editor"
          value={sql}
          onChange={setSql}
          onRun={() => void run()}
          onRunStatement={t => void runText(t)}
          onRunAll={() => void runAll()}
          onCaret={(a, b) => (caret.current = { a, b })}
          completion={completion}
          placeholder="写 SQL，Ctrl + Enter 运行光标所在的那条语句；输入时有表名、字段、关键字提示，Ctrl + 空格手动唤起"
        />
      </div>
      <div className="qv-split" onPointerDown={splitDrag} title="拖动调整高度" />
      <div className="qv-res">
        {err ? (
          <div className="tv-err" data-testid="qv-err">
            {err}
          </div>
        ) : res ? (
          res.columns.length ? (
            <DataGrid testid="qv-grid" columns={res.columns.map(c => ({ name: c.name, type: c.dataType }))} rows={res.rows.map(cells => ({ cells }))} resetKey={gen} empty="查询没有返回数据" />
          ) : (
            <div className="qv-ok" data-testid="qv-ok">
              <Icon name="check" size={16} /> 执行成功{res.affectedRows !== undefined ? `，影响 ${res.affectedRows} 行` : ""}
            </div>
          )
        ) : (
          <div className="dg-empty">{running ? "运行中…" : "运行后结果显示在这里"}</div>
        )}
        {res && (
          <div className="tv-foot">
            <span data-testid="qv-count">{res.columns.length ? `${res.rowCount} 行${res.truncated ? "（只取了前 1000 行）" : ""}` : "无结果集"}</span>
            <span className="dim">{res.elapsedMs} ms</span>
            <span className="dim mono qv-ran" title={ran}>
              {ran.replace(/\s+/g, " ").slice(0, 80)}
            </span>
            <span className="spacer" />
            {res.columns.length > 0 && (
              <>
                <button className="btn sm" onClick={() => download("query.csv", toCsv(res.columns, res.rows), "text/csv")}>
                  <Icon name="download" size={13} /> CSV
                </button>
                <button className="btn sm" onClick={() => download("query.json", toJson(res.columns, res.rows), "application/json")}>
                  <Icon name="download" size={13} /> JSON
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
