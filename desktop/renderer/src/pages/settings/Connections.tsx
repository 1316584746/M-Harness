import { useCallback, useEffect, useMemo, useState } from "react";
import { CONN_FIELDS, CONN_KINDS, DB_TYPES, DEFAULTS, ENV_PRESETS, connKindOf, connSummary, fieldVisible, isSecretField, type ConnKind, type ConnTestResult, type Connection, type ConnectionInput, type FieldDef } from "../../../../shared/connections";
import { api } from "../../api";
import { GitlabFromHosts } from "../../components/GitlabFromHosts";
import { Icon, type IconName } from "../../components/Icon";
import { Switch } from "./Projects";

const envClass = (env: string) => (env === "生产" ? "prod" : env === "预发" ? "pre" : env === "测试" ? "test" : env === "开发" ? "dev" : "other");
const envRank = (env: string) => {
  const i = ENV_PRESETS.indexOf(env);
  return i < 0 ? ENV_PRESETS.length : i;
};

type Result = ConnTestResult | "testing";

/** 连接：XXL-JOB / 数据库 / Redis / 服务器 / 内嵌终端。每类可以有多个，用环境和机器区分 */
export function Connections() {
  const [list, setList] = useState<Connection[]>([]);
  const [kind, setKind] = useState<ConnKind>("xxljob");
  const [env, setEnv] = useState("all");
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<ConnectionInput | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [delId, setDelId] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => setList(await api.connectionList()), []);
  useEffect(() => void load(), [load]);

  const ofKind = useMemo(() => list.filter(c => c.kind === kind), [list, kind]);
  const envs = useMemo(() => [...new Set(ofKind.map(c => c.env))].sort((a, b) => envRank(a) - envRank(b) || a.localeCompare(b, "zh")), [ofKind]);
  useEffect(() => {
    if (env !== "all" && !envs.includes(env)) setEnv("all");
  }, [envs, env]);
  const serverName = (id: string) => list.find(c => c.id === id)?.name;
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return ofKind
      .filter(c => (env === "all" || c.env === env) && (!k || [c.name, c.machine, c.env, c.note ?? "", connSummary(c, serverName)].join(" ").toLowerCase().includes(k)))
      .sort((a, b) => envRank(a.env) - envRank(b.env) || a.env.localeCompare(b.env, "zh") || a.machine.localeCompare(b.machine, "zh") || a.name.localeCompare(b.name, "zh"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ofKind, env, q, list]);
  const groups = useMemo(() => {
    const m = new Map<string, Connection[]>();
    for (const c of shown) m.set(c.env, [...(m.get(c.env) ?? []), c]);
    return [...m.entries()];
  }, [shown]);

  const test = async (c: Connection) => {
    setResults(r => ({ ...r, [c.id]: "testing" }));
    const res = await api.connectionTest({ id: c.id, kind: c.kind, name: c.name, env: c.env, machine: c.machine, fields: c.fields });
    setResults(r => ({ ...r, [c.id]: res }));
  };
  const testAll = async () => {
    const todo = shown.filter(c => c.enabled);
    for (let i = 0; i < todo.length; i += 3) await Promise.all(todo.slice(i, i + 3).map(test));
  };

  const info = connKindOf(kind);
  const newOne = () => setEdit({ kind, name: "", env: env !== "all" ? env : "开发", machine: "", fields: { ...DEFAULTS[kind] }, secrets: {} });

  return (
    <div className="page conn-page" data-testid="connections-page">
      <div className="conn-layout">
      <nav className="conn-kinds" data-testid="conn-kinds">
        {CONN_KINDS.map(k => {
          const n = list.filter(c => c.kind === k.kind).length;
          return (
            <button key={k.kind} className={`conn-kind ${kind === k.kind ? "on" : ""}`} data-testid={`conn-kind-${k.kind}`} onClick={() => (setKind(k.kind), setEnv("all"), setQ(""), setDelId(null))}>
              <span className="conn-kico" style={{ background: k.color }}>
                <Icon name={k.icon as IconName} size={12} />
              </span>
              <span className="conn-kname">{k.label}</span>
              {n > 0 && <span className="auto-count">{n}</span>}
            </button>
          );
        })}
      </nav>

      <div className="conn-content">
      <div className="page-head">
        <h1>连接</h1>
        <button className="btn primary" data-testid="conn-new" onClick={newOne}>
          <Icon name="plus" size={14} /> 新建{info.label}连接
        </button>
      </div>
      <p className="conn-lead">管理 XXL-JOB、GitLab、数据库、Redis、服务器和内嵌终端的连接。同一类可以添加多个，用「环境」和「机器」区分。密码加密保存在本机，界面上不会再显示出来。</p>
      {ofKind.length > 0 && (
        <div className="conn-filter">
          <div className="conn-envs">
            <button className={`conn-chip ${env === "all" ? "on" : ""}`} data-testid="conn-env-all" onClick={() => setEnv("all")}>
              全部环境
            </button>
            {envs.map(e => (
              <button key={e} className={`conn-chip ${env === e ? "on" : ""}`} data-testid={`conn-env-${e}`} onClick={() => setEnv(e)}>
                {e}
              </button>
            ))}
          </div>
          <label className="auto-search conn-search">
            <Icon name="search" size={13} />
            <input data-testid="conn-search" placeholder="搜索名称、机器、地址" value={q} onChange={e => setQ(e.target.value)} />
          </label>
          <button className="btn sm" data-testid="conn-test-all" disabled={!shown.some(c => c.enabled)} onClick={() => void testAll()}>
            <Icon name="refresh" size={13} /> 全部测试
          </button>
        </div>
      )}

      {err && (
        <div className="inline-warn" data-testid="conn-err">
          {err}
        </div>
      )}

      {!ofKind.length ? (
        <div className="auto-empty" data-testid="conn-empty">
          <span className="auto-empty-ico">
            <Icon name={info.icon as IconName} size={30} />
          </span>
          <p>还没有{info.label}连接</p>
          <p style={{ fontSize: 12.5 }}>{info.hint}</p>
          {kind === "gitlab" && <GitlabFromHosts onDone={() => void load()} />}
          <button className="btn primary" onClick={newOne}>
            <Icon name="plus" size={14} /> 新建{info.label}连接
          </button>
        </div>
      ) : !shown.length ? (
        <div className="auto-empty" data-testid="conn-nomatch">
          <p>没有符合条件的连接</p>
        </div>
      ) : (
        groups.map(([e, items]) => (
          <section key={e} className="conn-group" data-testid="conn-group" data-env={e}>
            <div className="conn-group-head">
              <span className={`conn-env ${envClass(e)}`}>{e}</span>
              <span className="auto-count">{items.length} 个</span>
            </div>
            <div className="conn-list">
              {items.map(c => {
                const r = results[c.id];
                return (
                  <div key={c.id} className={`conn-card ${c.enabled ? "" : "off"}`} data-testid="conn-card" data-id={c.id} data-kind={c.kind} data-env={c.env}>
                    <div className="conn-main">
                      <div className="conn-title">
                        <b data-testid="conn-name">{c.name}</b>
                        {c.machine && (
                          <span className="conn-machine" data-testid="conn-machine">
                            <Icon name="globe" size={11} /> {c.machine}
                          </span>
                        )}
                        {!c.enabled && <span className="conn-off">已停用</span>}
                      </div>
                      <div className="conn-sum mono" data-testid="conn-summary">
                        {connSummary(c, serverName)}
                      </div>
                      {c.note && <div className="conn-note">{c.note}</div>}
                      {r && (
                        <div className={`conn-result ${r === "testing" ? "run" : r.ok ? "ok" : "bad"}`} data-testid="conn-result">
                          {r === "testing" ? (
                            <>
                              <span className="spinner" /> 正在测试…
                            </>
                          ) : (
                            <>
                              <Icon name={r.ok ? "check" : "alert"} size={12} /> {r.message}
                              {r.detail ? <span className="conn-detail">{r.detail}</span> : null}
                              <span className="conn-ms">{r.ms} ms</span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="conn-acts">
                      <Switch on={c.enabled} testid="conn-switch" onChange={v => void api.connectionToggle(c.id, v).then(x => (setErr(x.ok ? "" : (x.error ?? "")), load()))} />
                      <button className="btn sm" data-testid="conn-test" disabled={r === "testing"} onClick={() => void test(c)}>
                        测试
                      </button>
                      <button className="btn sm" data-testid="conn-edit" onClick={() => setEdit({ id: c.id, kind: c.kind, name: c.name, env: c.env, machine: c.machine, note: c.note, enabled: c.enabled, fields: { ...DEFAULTS[c.kind], ...c.fields }, secrets: {} })}>
                        编辑
                      </button>
                      {delId === c.id ? (
                        <>
                          <button
                            className="btn sm danger"
                            data-testid="conn-del-confirm"
                            onClick={async () => {
                              const x = await api.connectionRemove(c.id);
                              setErr(x.ok ? "" : (x.error ?? "删除失败"));
                              setDelId(null);
                              void load();
                            }}
                          >
                            确认删除
                          </button>
                          <button className="btn sm" onClick={() => setDelId(null)}>
                            取消
                          </button>
                        </>
                      ) : (
                        <button className="btn sm icon" title="删除" data-testid="conn-del" onClick={() => setDelId(c.id)}>
                          <Icon name="trash" size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
      </div>
      </div>

      {edit && (
        <ConnEditor
          init={edit}
          servers={list.filter(c => c.kind === "server")}
          secretSet={list.find(c => c.id === edit.id)?.secretSet ?? {}}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ConnEditor({ init, servers, secretSet, onClose, onSaved }: { init: ConnectionInput; servers: Connection[]; secretSet: Record<string, boolean>; onClose: () => void; onSaved: () => void }) {
  const info = connKindOf(init.kind);
  const defs = CONN_FIELDS[init.kind];
  const [name, setName] = useState(init.name);
  const [envSel, setEnvSel] = useState(ENV_PRESETS.includes(init.env) ? init.env : "__custom");
  const [envText, setEnvText] = useState(ENV_PRESETS.includes(init.env) ? "" : init.env);
  const [machine, setMachine] = useState(init.machine);
  const [note, setNote] = useState(init.note ?? "");
  const [vals, setVals] = useState<Record<string, string>>(init.fields);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);

  const env = envSel === "__custom" ? envText : envSel;
  const draft = (): ConnectionInput => ({ id: init.id, kind: init.kind, name, env, machine, note, enabled: init.enabled, fields: vals, secrets });
  const set = (k: string, v: string) => {
    setVals(o => {
      const next = { ...o, [k]: v };
      // 换数据库类型时，端口还是上一个类型的默认值就跟着换
      if (init.kind === "database" && k === "dbType") {
        const prev = DB_TYPES.find(d => d.value === o.dbType)?.port;
        const cur = DB_TYPES.find(d => d.value === v)?.port;
        if (cur && (!o.port || String(prev) === o.port)) next.port = String(cur);
      }
      return next;
    });
    setErr("");
    setRes(null);
  };

  const save = async () => {
    setBusy(true);
    const r = await api.connectionSave(draft());
    setBusy(false);
    if (r.ok) onSaved();
    else setErr(r.error ?? "保存失败");
  };
  const test = async () => {
    setRes("testing");
    setErr("");
    setRes(await api.connectionTest(draft()));
  };

  const input = (d: FieldDef) => {
    const v = vals[d.key] ?? "";
    const tid = `conn-f-${d.key}`;
    if (d.kind === "select")
      return (
        <select className="input" data-testid={tid} value={v} onChange={e => set(d.key, e.target.value)}>
          {d.options?.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    if (d.kind === "connection")
      return (
        <select className="input" data-testid={tid} value={v} onChange={e => set(d.key, e.target.value)}>
          <option value="">{servers.length ? "请选择服务器连接" : "还没有服务器连接，请先添加"}</option>
          {servers.map(s => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.env}
              {s.machine ? ` · ${s.machine}` : ""}
            </option>
          ))}
        </select>
      );
    if (d.kind === "bool")
      return (
        <label className="conn-check">
          <input type="checkbox" data-testid={tid} checked={v === "true"} onChange={e => set(d.key, e.target.checked ? "true" : "false")} /> 启用
        </label>
      );
    if (isSecretField(d))
      return (
        <SecretInput
          testid={tid}
          placeholder={secretSet[d.key] ? "已设置，留空表示不修改" : (d.placeholder ?? "")}
          value={secrets[d.key] ?? ""}
          onChange={v => {
            // 留空 = 不修改（输入后又删光也一样，避免误清掉已保存的密码）
            setSecrets(o => {
              const n = { ...o, [d.key]: v };
              if (!v) delete n[d.key];
              return n;
            });
            setErr("");
            setRes(null);
          }}
        />
      );
    return <input className={`input ${d.kind === "number" ? "num" : ""}`} data-testid={tid} inputMode={d.kind === "number" ? "numeric" : undefined} placeholder={d.placeholder} value={v} onChange={e => set(d.key, e.target.value)} />;
  };

  const rows = defs.filter(d => fieldVisible(d, vals));

  return (
    <div className="modal-mask" data-testid="conn-editor" role="dialog" aria-modal onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal auto-modal conn-modal">
        <h3>
          {init.id ? "编辑" : "新建"}
          {info.label}连接
        </h3>
        <label className="auto-field">
          <span>名称</span>
          <input className="input" data-testid="conn-f-name" placeholder="比如：订单库-主库" value={name} onChange={e => (setName(e.target.value), setErr(""))} autoFocus />
        </label>
        <div className="auto-two">
          <div className="auto-field">
            <span>环境</span>
            <select className="input" data-testid="conn-f-env" value={envSel} onChange={e => (setEnvSel(e.target.value), setErr(""))}>
              {ENV_PRESETS.map(e => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
              <option value="__custom">自定义…</option>
            </select>
            {envSel === "__custom" && <input className="input" data-testid="conn-f-env-custom" placeholder="环境名，比如：灰度" value={envText} onChange={e => (setEnvText(e.target.value), setErr(""))} />}
          </div>
          <label className="auto-field">
            <span>机器</span>
            <input className="input" data-testid="conn-f-machine" placeholder="节点、机房或实例名（可选）" value={machine} onChange={e => (setMachine(e.target.value), setErr(""))} />
          </label>
        </div>

        {rows.map(d => (
          <label key={d.key} className="auto-field" data-testid={`conn-field-${d.key}`}>
            <span>
              {d.label}
              {d.required && <em className="conn-req">*</em>}
            </span>
            {input(d)}
            {d.hint && <small className="conn-hint">{d.hint}</small>}
          </label>
        ))}

        <label className="auto-field">
          <span>备注</span>
          <input className="input" data-testid="conn-f-note" placeholder="可选" value={note} onChange={e => setNote(e.target.value)} />
        </label>

        {res && (
          <div className={`conn-result big ${res === "testing" ? "run" : res.ok ? "ok" : "bad"}`} data-testid="conn-ed-result">
            {res === "testing" ? (
              <>
                <span className="spinner" /> 正在测试…
              </>
            ) : (
              <>
                <Icon name={res.ok ? "check" : "alert"} size={13} /> {res.message}
                {res.detail ? <span className="conn-detail">{res.detail}</span> : null}
                <span className="conn-ms">{res.ms} ms</span>
              </>
            )}
          </div>
        )}
        {err && (
          <div className="inline-warn" data-testid="conn-f-err">
            {err}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" data-testid="conn-ed-test" disabled={res === "testing"} onClick={() => void test()}>
            测试连接
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" data-testid="conn-f-cancel" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" data-testid="conn-f-save" disabled={busy} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/** 密码 / 令牌输入框：右侧的眼睛切换显示或隐藏（只影响正在输入的内容；已保存的秘密不会回传到界面） */
function SecretInput({ value, onChange, placeholder, testid }: { value: string; onChange: (v: string) => void; placeholder?: string; testid: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="conn-secret">
      <input className="input" type={show ? "text" : "password"} autoComplete="new-password" spellCheck={false} data-testid={testid} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
      <button type="button" className="conn-eye" data-testid={`${testid}-eye`} title={show ? "隐藏" : "显示"} aria-label={show ? "隐藏" : "显示"} onClick={e => (e.preventDefault(), setShow(s => !s))}>
        <Icon name={show ? "eyeOff" : "eye"} size={15} />
      </button>
    </span>
  );
}