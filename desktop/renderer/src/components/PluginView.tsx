import { useEffect, useRef, useState } from "react";
import type { PluginConn, PluginDbAccess, UiPlugin } from "../../../shared/pluginhost";
import { pluginUrl } from "../../../shared/pluginhost";
import { connKindOf, type ConnKind } from "../../../shared/connections";
import { api } from "../api";
import { isBenignPluginError } from "../lib/pluginErr";
import type { PluginFocus, PluginScope } from "../lib/pluginFocus";
import { GitlabFromHosts } from "./GitlabFromHosts";
import { Icon } from "./Icon";

/** 把当前主题换成插件界面用的颜色变量（--color-*），插件的小组件库按它上色 */
function themeTokens(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    "--color-background": v("--bg"),
    "--color-foreground": v("--text"),
    "--color-card": v("--surface"),
    "--color-border": v("--border"),
    "--color-input": v("--border-strong"),
    "--color-primary": v("--accent"),
    "--color-primary-foreground": v("--accent-text"),
    "--color-muted": v("--surface-2"),
    "--color-muted-foreground": v("--text-2"),
    "--color-accent": v("--accent-soft"),
    "--color-destructive": v("--bad"),
    "--color-ring": v("--accent"),
  };
}

const isProd = (env: string) => /生产|线上|prod/i.test(env);

/** 数据库类插件：勾选哪些数据库连接可以给它用（只读） */
function DbPicker({ access, picked, onToggle }: { access: PluginDbAccess; picked: Set<string>; onToggle: (id: string) => void }) {
  if (access.options.length === 0) return <div className="plug-db-empty">还没有数据库连接，先到「设置 → 连接」添加。</div>;
  return (
    <div className="plug-db-list" data-testid="plugin-db-list">
      {access.options.map(o => (
        <label key={o.id} className={`plug-db-row${o.supported ? "" : " off"}`}>
          <input type="checkbox" data-testid={`plugin-db-${o.id}`} disabled={!o.supported} checked={picked.has(o.id)} onChange={() => onToggle(o.id)} />
          <span className="plug-db-name">{o.name}</span>
          <span className={`plug-db-env${isProd(o.env) ? " prod" : ""}`}>{o.env}</span>
          {o.machine && <span className="plug-db-mach">{o.machine}</span>}
          <span className="plug-db-type">{o.supported ? o.dbType : `${o.dbType}（暂不支持）`}</span>
          {o.supported && <span className={`plug-db-rw${o.writable ? " w" : ""}`}>{o.writable ? "可读写" : "只读"}</span>}
        </label>
      ))}
    </div>
  );
}

/**
 * 在应用里打开一个插件：界面放进只开 allow-scripts 的 iframe（碰不到本软件页面），
 * 它需要的一切都通过 postMessage 找这里，再转给主进程。
 * 带本机程序的插件，第一次运行前先让用户确认。
 */
export function PluginView({ plugin, theme, active, onManageConnections, focus, scope }: { plugin: UiPlugin; theme: string; active: boolean; onManageConnections?: (kind?: ConnKind) => void; focus?: PluginFocus; scope?: PluginScope }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [trusted, setTrusted] = useState(plugin.trusted);
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);
  // 数据库类插件：授权界面
  const dataKind = !!plugin.dataAccess;
  const [access, setAccess] = useState<PluginDbAccess | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showAccess, setShowAccess] = useState(false);
  // 连接类插件（如 XXL-JOB）：用「设置 → 连接」里的连接，不需要 DBX
  const kind = plugin.connKind;
  const [reload, setReload] = useState(0);
  // 连接在「设置 → 连接」里改了（比如关掉只读）：插件界面按新配置重新加载
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!kind) return;
    return api.onConnectionsChanged(() => {
      setReload(n => n + 1);
      setGen(n => n + 1);
      setLoaded(false);
    });
  }, [kind]);
  const selKey = `harness.pluginConn.${plugin.id}`;
  const [conns, setConns] = useState<PluginConn[] | null>(kind ? null : []);
  const [sel, setSel] = useState("");
  const selRef = useRef("");
  const baseCtx = useRef<Record<string, unknown>>({});
  selRef.current = sel;
  const connsRef = useRef<PluginConn[]>([]);
  connsRef.current = conns ?? [];

  useEffect(() => {
    if (!kind || !active) return;
    let live = true;
    void api.pluginConnections(plugin.id).then(l => {
      if (!live) return;
      setConns(l);
      setSel(cur => (l.some(c => c.id === cur) ? cur : l.some(c => c.id === localStorage.getItem(selKey)) ? (localStorage.getItem(selKey) as string) : (l[0]?.id ?? "")));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, active, plugin.id, reload, trusted]);

  // 要读数据库的插件：首次确认前、或者打开「数据库访问」时，取一次可选的连接
  useEffect(() => {
    if (!dataKind || !(!trusted || showAccess)) return;
    let live = true;
    void api.pluginDbAccess(plugin.id).then(a => {
      if (!live) return;
      setAccess(a);
      setPicked(new Set(trusted ? a.granted : a.options.filter(o => o.supported && !isProd(o.env)).map(o => o.id)));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKind, trusted, showAccess, plugin.id]);

  const toggleGrant = async (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
    await api.pluginSetGrants(plugin.id, [...next]);
    setReload(n => n + 1);
  };

  // 从「数据库」页点了某个连接：直接切到它（没授权给这个插件的会被忽略）
  useEffect(() => {
    if (kind !== "database") return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ pluginId: string; connId: string }>).detail;
      if (d?.pluginId === plugin.id && connsRef.current.some(c => c.id === d.connId)) setSel(d.connId);
    };
    window.addEventListener("harness:plugin-pick", on);
    return () => window.removeEventListener("harness:plugin-pick", on);
  }, [kind, plugin.id]);

  // 换了连接：通知插件界面，它会按新连接重新加载
  const sentSel = useRef("");
  useEffect(() => {
    if (!kind || kind === "database" || !loaded || !sel || sel === sentSel.current) return;
    sentSel.current = sel;
    post({ kind: "context", context: { ...baseCtx.current, ...connCtx(sel) } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, loaded]);

  useEffect(() => setTrusted(plugin.trusted), [plugin.trusted, plugin.version]);

  /** 连接类插件的上下文：连接 id；SSH 终端另带连接名（它的标题 / 标签靠这个显示名字，不然只能显示一串 id） */
  const connCtx = (id: string) => {
    const c = connsRef.current.find(x => x.id === id);
    return { connectionId: id, ...(c && kind === "server" ? { connection: { id, name: c.name } } : {}) };
  };
  const post = (m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ __dbx: 1, ...m }, "*");

  useEffect(() => {
    if (!trusted) return;
    const onMsg = async (e: MessageEvent) => {
      const w = frame.current?.contentWindow;
      const m = e.data as { __dbx?: number; kind?: string; id?: number; method?: string; params?: unknown };
      if (!w || e.source !== w || !m || m.__dbx !== 1) return;
      if (m.kind === "hello") {
        baseCtx.current = ((await api.pluginRequest(plugin.id, "host.getContext", {})).result ?? {}) as Record<string, unknown>;
        sentSel.current = selRef.current;
        const caps = ((await api.pluginRequest(plugin.id, "host.getCapabilities", {})).result ?? {}) as Record<string, boolean>;
        const dc = connsRef.current.find(c => c.id === selRef.current);
        const ctx = kind && selRef.current ? { ...baseCtx.current, ...(kind === "database" ? { connectionId: selRef.current } : connCtx(selRef.current)), ...(kind === "database" && dc ? { id: dc.id, name: dc.name, dbType: dc.dbType, database: dc.database ?? "" } : {}) } : baseCtx.current;
        post({ kind: "init", context: focusRef.current ? { ...ctx, focus: focusRef.current } : ctx, locale: "zh-CN", theme: { appearance: theme, tokens: themeTokens() }, capabilities: caps });
      } else if (m.kind === "request" && typeof m.id === "number" && typeof m.method === "string") {
        // 只看某几次运行：后台请求都带上范围，主进程用只含这几次运行的临时家目录来答
        const r = await api.pluginRequest(plugin.id, m.method, m.params, m.method === "backend.invoke" ? scopeRef.current : undefined);
        if (!r.ok && m.method === "backend.invoke") setErr(isBenignPluginError(r.error ?? "") ? "" : (r.error ?? ""));
        else if (r.ok && m.method === "backend.invoke") setErr("");
        post({ kind: "response", id: m.id, ...(r.ok ? { result: r.result ?? null } : { error: r.error ?? "失败" }) });
      } else if (m.kind === "notify" && typeof m.method === "string") {
        void api.pluginRequest(plugin.id, "backend.notify", { method: m.method, params: m.params }, scopeRef.current);
      }
    };
    window.addEventListener("message", onMsg);
    const off = api.onPluginEvent(ev => ev.id === plugin.id && post({ kind: "event", method: ev.method, params: ev.params }));
    const offBin = api.onPluginBinary(ev => ev.id === plugin.id && post({ kind: "binary", channel: ev.channel, data: ev.data }));
    return () => {
      window.removeEventListener("message", onMsg);
      off();
      offBin();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trusted, plugin.id, theme]);

  // 主题切换：等页面把 data-theme 改完再取颜色
  useEffect(() => {
    if (!trusted || !loaded) return;
    const t = setTimeout(() => post({ kind: "theme", theme: { appearance: theme, tokens: themeTokens() } }), 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, trusted, loaded]);

  if (!trusted) {
    return (
      <div className="plug-consent" data-testid="plugin-consent" hidden={!active}>
        <div className="plug-consent-card">
          <div className="plug-consent-head">
            {plugin.icon ? <img src={plugin.icon} alt="" width={28} height={28} /> : <Icon name="plug" size={24} />}
            <b>{plugin.name}</b>
            <span>{plugin.version}</span>
          </div>
          {plugin.backend ? (
            <>
              <p>这个插件带有一个本机程序，运行后会在你的电脑上以你的权限工作，它能读写你的文件、访问网络，本软件没法限制。</p>
              <p>请只运行你信任的插件。它的界面本身是隔离的，只有后台程序需要你确认。</p>
            </>
          ) : (
            <p>这个插件的界面是隔离的，没有本机程序。它想使用你的数据库，下面勾选的连接才会给它用。开发 / 测试环境的库可以读写，其他环境（生产、预发等）一律只读。</p>
          )}
          {dataKind && access && (
            <div className="plug-db-grant">
              <div className="plug-db-title">允许它使用这些数据库（默认不勾生产）</div>
              <DbPicker
                access={access}
                picked={picked}
                onToggle={id =>
                  setPicked(s => {
                    const n = new Set(s);
                    if (n.has(id)) n.delete(id);
                    else n.add(id);
                    return n;
                  })
                }
              />
            </div>
          )}
          {plugin.permissions.length > 0 && (
            <div className="plug-consent-perms">
              声明的权限：
              {plugin.permissions.map(p => (
                <code key={p}>{p}</code>
              ))}
            </div>
          )}
          <div className="plug-consent-actions">
            <button
              className="btn primary"
              data-testid="plugin-trust"
              onClick={async () => {
                if (await api.pluginTrust(plugin.id, dataKind ? [...picked] : undefined)) setTrusted(true);
              }}
            >
              信任并运行
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="plug-view" data-testid="plugin-view" data-plugin={plugin.id} hidden={!active}>
      {err && (
        <div className="plug-err" data-testid="plugin-error">
          <span>插件后台出错：{err}</span>
          <button className="plug-err-x" data-testid="plugin-error-close" title="关闭" aria-label="关闭" onClick={() => setErr("")}>
            ×
          </button>
        </div>
      )}
      {kind && conns && conns.length > 0 && (
        <div className="plug-conn-bar" data-testid="plugin-conn-bar">
          <span>连接</span>
          <select
            className="input"
            data-testid="plugin-conn-select"
            value={sel}
            onChange={e => {
              setSel(e.target.value);
              localStorage.setItem(selKey, e.target.value);
              setErr("");
            }}
          >
            {conns.map(c => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.env}
                {c.machine ? ` · ${c.machine}` : ""}
              </option>
            ))}
          </select>
          <span className="plug-conn-sum mono">{conns.find(c => c.id === sel)?.summary}</span>
          <span style={{ flex: 1 }} />
          {kind === "database" ? (
            <button className="btn sm" data-testid="plugin-db-access" onClick={() => setShowAccess(s => !s)}>
              数据库访问
            </button>
          ) : (
            <button className="btn sm" data-testid="plugin-conn-manage" onClick={() => onManageConnections?.(kind)}>
              管理连接
            </button>
          )}
        </div>
      )}
      {kind === "database" && showAccess && access && (
        <div className="plug-db-panel" data-testid="plugin-db-panel">
          <div className="plug-db-title">这个插件可以使用的数据库（测试 / 开发的库可读写，其他只读；查询有超时和行数上限）</div>
          <DbPicker access={access} picked={picked} onToggle={id => void toggleGrant(id)} />
          <div className="plug-db-foot">
            <button className="btn sm" onClick={() => onManageConnections?.(kind)}>
              管理连接
            </button>
            <button className="btn sm" onClick={() => setShowAccess(false)}>
              关闭
            </button>
          </div>
        </div>
      )}
      {kind && conns && conns.length === 0 ? (
        <div className="plug-noconn" data-testid="plugin-noconn">
          <Icon name="plug" size={34} />
          <h3>{kind === "database" ? "还没有允许这个插件使用的数据库" : `还没有 ${connKindOf(kind).label} 连接`}</h3>
          <p>{kind === "database" ? "先到「设置 → 连接」添加数据库连接，再在这里勾选允许它使用哪些（测试 / 开发的库可读写，其他只读）。" : "先到「设置 → 连接」添加一个，再回来打开。可以按环境、机器添加多个。"}</p>
          {kind === "gitlab" && <GitlabFromHosts onDone={() => setReload(n => n + 1)} />}
          {kind === "database" && (
            <button className="btn primary" data-testid="plugin-db-access" onClick={() => setShowAccess(s => !s)}>
              选择数据库
            </button>
          )}
          <button className={`btn${kind === "database" ? "" : " primary"}`} data-testid="plugin-noconn-add" onClick={() => onManageConnections?.(kind)}>
            去添加连接
          </button>
        </div>
      ) : (
        (!kind || (conns && sel)) && <iframe key={`${kind === "database" ? sel : "f"}:${gen}`} ref={frame} className="plug-frame" data-testid="plugin-frame" title={plugin.name} sandbox="allow-scripts" src={pluginUrl(plugin.id) + (focus?.tab ? `?focus=${encodeURIComponent(focus.tab)}` : "")} onLoad={() => setLoaded(true)} />
      )}
    </div>
  );
}
