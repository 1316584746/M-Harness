import { useMemo, useState, type ReactNode } from "react";
import type { AppState } from "../../../../shared/api";
import { DBX_SOURCE, ECOSYSTEM_LABEL, LOCAL_SOURCE, type LocalPluginInfo, type MarketResult, type PluginEntry } from "../../../../shared/plugins";
import { api } from "../../api";
import { Icon, type IconName } from "../../components/Icon";
import { Avatar, dateText, Msg, verText } from "./common";

function Section({ icon, title, desc, right, children }: { icon: IconName; title: string; desc?: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-sec">
      <div className="px-sec-head">
        <Icon name={icon} size={15} />
        <div className="px-sec-title">{title}</div>
        {right && <div className="px-sec-right">{right}</div>}
      </div>
      {desc && <div className="px-sec-desc">{desc}</div>}
      {children}
    </div>
  );
}

interface Row {
  id: string;
  key: string;
  name: string;
  version: string;
  /** 装在本软件插件目录里的内容摘要 */
  local?: LocalPluginInfo;
  entry?: PluginEntry;
}

/** 已安装：只列装在本软件里的插件（和本机有没有 DBX 无关）。左边列表，右边是详情、更新、卸载 */
export function Installed({ market, loading, reload }: { state?: AppState; onChanged?: () => void; market: MarketResult | null; loading: boolean; reload: (refresh?: boolean, silent?: boolean) => void }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [cur, setCur] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const rows = useMemo<Row[]>(() => {
    const dbxEntries = new Map((market?.entries ?? []).map(e => [e.id, e]));
    const dbxRows = Object.entries(market?.dbx?.local ?? {}).map(([id, local]) => {
      const entry = dbxEntries.get(id);
      return { id, key: entry?.key ?? `${DBX_SOURCE}:${id}`, name: entry?.name ?? local.name ?? id, version: local.version, local, entry } as Row;
    });
    return dbxRows.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [market]);
  const hasNew = (r: Row) => {
    const have = r.local?.listed ?? r.version;
    return !!r.entry?.version && !!have && r.entry.version !== have;
  };
  const updatable = rows.filter(hasNew);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? rows.filter(r => [r.name, r.id, r.entry?.description ?? ""].join(" ").toLowerCase().includes(k)) : rows;
  }, [rows, q]);
  const row = rows.find(r => r.id === cur) ?? shown[0] ?? rows[0];

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, okNote = "") => {
    setErr("");
    setNote("");
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setErr(r.error ?? "操作失败");
    else if (okNote) setNote(okNote);
    return r.ok;
  };
  const update = async (r: Row) => {
    const ok = await act(() => api.pluginInstall(r.id), `已更新「${r.name}」`);
    if (ok) reload(false, true);
  };
  const remove = async (r: Row) => {
    if (!window.confirm(`卸载「${r.name}」？会删除本软件里这个插件的文件。`)) return;
    const ok = await act(() => api.pluginUninstall(r.id), `已卸载「${r.name}」`);
    if (ok) {
      setCur(null);
      reload(false, true);
    }
  };

  return (
    <div className="pstore" data-testid="plugin-installed">
      <div className="pi-top">
        <button className="btn sm icon" title="重新读取已安装的插件" data-testid="installed-refresh" disabled={loading} onClick={() => reload(true)}>
          {loading ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
        </button>
      </div>

      {rows.length > 0 &&
        (updatable.length === 0 ? (
          <div className="px-msg ok px-note" data-testid="installed-uptodate">
            <Icon name="check" size={14} /> 所有插件均已是最新版本。
          </div>
        ) : (
          <div className="px-msg warn px-note" data-testid="installed-hasupdate">
            <Icon name="alert" size={14} /> 有 {updatable.length} 个插件可以更新
          </div>
        ))}
      {err && <Msg className="px-msg bad">{err}</Msg>}
      {note && <Msg className="px-msg ok">{note}</Msg>}

      {rows.length === 0 ? (
        <div className="wb-empty" data-testid="plugin-installed-empty">
          还没有安装插件，到「插件商店」里装一个
        </div>
      ) : (
        <div className="pi-split">
          <div className="pi-list">
            <label className="pi-search">
              <Icon name="search" size={13} />
              <input data-testid="installed-search" placeholder={`搜索 ${rows.length} 个已安装插件…`} value={q} onChange={e => setQ(e.target.value)} />
            </label>
            <div className="pi-scroll" data-testid="installed-list">
            {shown.length === 0 && <div className="pi-none" data-testid="installed-none">没有匹配「{q.trim()}」的插件</div>}
            {shown.map(r => (
              <button key={r.id} className={`pi-item ${r.id === row?.id ? "on" : ""}`} data-testid="installed-row" data-key={r.key} onClick={() => setCur(r.id)}>
                <span className="pi-tick">{r.id === row?.id && <Icon name="check" size={13} />}</span>
                <Avatar name={r.name} size={32} />
                <span className="pi-item-main">
                  <span className="pi-item-name">{r.name}</span>
                  <span className="pi-badges">
                    {r.local?.ecosystem && <span className={`px-eco eco-${r.local.ecosystem}`}>{ECOSYSTEM_LABEL[r.local.ecosystem]}</span>}
                    {r.version && <span className="px-tag">{verText(r.version)}</span>}
                    {hasNew(r) && <span className="px-update">可更新</span>}
                  </span>
                </span>
              </button>
            ))}
            </div>
          </div>

          {row && (
            <div className="pi-detail" data-testid="installed-detail" data-key={row.key}>
              <div className="pi-head">
                <Avatar name={row.name} size={40} />
                <div className="pi-head-main">
                  <div className="pi-title">{row.name}</div>
                  <div className="pi-desc">{row.entry?.description ?? "插件商店里已经找不到这个插件的介绍（可能是自己开发或第三方的插件）"}</div>
                  <div className="pi-id mono">
                    {row.id}
                    {row.entry?.repo && (
                      <a className="px-ico" href={row.entry.repo} target="_blank" rel="noreferrer" title="源码仓库">
                        <Icon name="repo" size={12} />
                      </a>
                    )}
                  </div>
                </div>
                <div className="pi-actions">
                  {hasNew(row) && (row.entry?.install.kind !== "dbx" || !!row.entry.install.url) && (
                    <button className="btn sm primary" data-testid="installed-update" disabled={busy} onClick={() => void update(row)}>
                      {busy ? <span className="spinner" /> : <Icon name="download" size={13} />} 更新到 {verText(row.entry!.version)}
                    </button>
                  )}
                  <button className="btn sm" data-testid="installed-uninstall" disabled={busy} onClick={() => void remove(row)}>
                    卸载
                  </button>
                </div>
              </div>

              {row.local?.ecosystem && (
                <Section icon="box" title="插件内容" desc={`${ECOSYSTEM_LABEL[row.local.ecosystem]}，本软件按它自己的方式运行。`}>
                  <div className="px-msg warn" data-testid="installed-foreign-note">
                    {row.local.summary}
                  </div>
                </Section>
              )}
              {row.local && !row.local.ecosystem && (
              <Section icon="box" title="插件内容" desc="读自插件自带的清单。">
                <div className="px-facts" data-testid="installed-content">
                  <span>界面</span>
                  <b>{row.local.ui ? "有" : "无"}</b>
                  <span>后台程序</span>
                  <b>{row.local.backend ? "有" : "无"}</b>
                  <span>AI 工具</span>
                  <b>{row.local.tools ? `${row.local.tools} 个` : "无"}</b>
                  <span>能力类型</span>
                  <b>{row.local.kinds.join("、") || "—"}</b>
                  <span>申请的权限</span>
                  <b>{row.local.permissions.join("、") || "无"}</b>
                </div>
                {(row.local.ui || row.local.backend || row.local.tools > 0) && (
                  <div className="px-msg warn" data-testid="installed-runtime-note">
                    {[row.local.ui && "这个插件有界面：点右侧插件栏里的图标打开。", row.local.backend && "它带有本机程序，第一次运行前需要你确认信任。", row.local.tools > 0 && (row.local.backend ? "它声明的 AI 工具，可以在「设置 → 让 AI 使用插件」里允许 AI 使用。" : "它声明的 AI 工具需要本机程序，这个插件没带，AI 用不了。")].filter(Boolean).join("")}
                  </div>
                )}
              </Section>
              )}

              <Section icon="info" title="来源">
                <div className="px-facts">
                  <span>来源</span>
                  <b>{row.entry?.source ?? LOCAL_SOURCE}</b>
                  <span>已装版本</span>
                  <b>{verText(row.version) || "—"}</b>
                  {row.entry?.author && (
                    <>
                      <span>作者</span>
                      <b>{row.entry.author}</b>
                    </>
                  )}
                  {row.entry?.license && (
                    <>
                      <span>协议</span>
                      <b>{row.entry.license}</b>
                    </>
                  )}
                  {row.entry?.updated && (
                    <>
                      <span>最近更新</span>
                      <b>{dateText(row.entry.updated)}</b>
                    </>
                  )}
                  <span>管理方式</span>
                  <b>装在本软件里，可在这里更新、卸载</b>
                </div>
              </Section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
