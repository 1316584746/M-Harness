import { useEffect, useMemo, useState } from "react";
import type { MarketResult, PluginEntry } from "../../../../shared/plugins";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { Avatar, dateText, haveVersions, verText } from "./common";

type Sort = "name-asc" | "name-desc" | "updated";
type St = "none" | "installed" | "update";

/** 插件商店：DBX 官方插件中心的插件。搜索、筛选、卡片 / 列表，点安装直接装进本软件（下载 + 校验 + 解压） */
const PLATFORM_NAME = /Mac/i.test(navigator.platform) ? "macOS" : /Linux/i.test(navigator.platform) ? "Linux" : "Windows";

export function Store({ market, loading, reload }: { market: MarketResult | null; loading: boolean; reload: (refresh?: boolean, silent?: boolean) => void }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("name-asc");
  const [status, setStatus] = useState("all");
  const [view, setView] = useState<"grid" | "list">(() => (localStorage.getItem("harness.plugins.view") === "list" ? "list" : "grid"));
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const entries = market?.entries ?? [];
  const local = useMemo(() => haveVersions(market), [market]);
  useEffect(() => localStorage.setItem("harness.plugins.view", view), [view]);
  useEffect(() => {
    if (!msg?.ok) return;
    const t = setTimeout(() => setMsg(null), 8000);
    return () => clearTimeout(t);
  }, [msg]);

  const stateOf = (e: PluginEntry): St => {
    const v = e.install.kind === "dbx" ? local[e.install.dbxId] : undefined;
    return !v ? "none" : e.version && v !== e.version ? "update" : "installed";
  };

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    const list = entries.filter(e => {
      const st = !local[e.id] ? "none" : e.version && local[e.id] !== e.version ? "update" : "installed";
      const stOk = status === "all" || (status === "installed" ? st !== "none" : status === "none" ? st === "none" : st === "update");
      return stOk && (!k || [e.name, e.id, e.author ?? "", e.description, e.tags.join(" ")].join(" ").toLowerCase().includes(k));
    });
    return list.sort((a, b) => (sort === "updated" ? (b.updated ?? "").localeCompare(a.updated ?? "") || a.name.localeCompare(b.name, "zh") : sort === "name-desc" ? b.name.localeCompare(a.name, "zh") : a.name.localeCompare(b.name, "zh")));
  }, [entries, q, sort, status, local]);

  const install = async (e: PluginEntry) => {
    if (e.install.kind !== "dbx" || !e.install.url) return;
    setMsg(null);
    setBusy(b => new Set([...b, e.key]));
    const r = await api.pluginInstall(e.install.dbxId);
    setBusy(b => new Set([...b].filter(k => k !== e.key)));
    if (r.ok) {
      setMsg({ ok: true, text: `已安装「${e.name}」${verText(r.version)}` });
      reload(false, true);
    } else setMsg({ ok: false, text: `安装「${e.name}」失败：${r.error ?? "未知错误"}` });
  };

  return (
    <div className="pstore" data-testid="plugin-store">
      <div className="px-banner">
        <Icon name="info" size={15} />
        <span>
          <b>插件由社区开发者维护</b>
          这里是 DBX 插件中心的插件，点「安装」会直接下载到本软件，并校验官方目录里的 sha256 和包内文件校验值，不需要装 DBX。插件问题请通过卡片上的源码仓库入口，前往对应插件仓库提交 Issue。
        </span>
      </div>

      <div className="px-toolbar">
        <label className="px-search">
          <Icon name="search" size={14} />
          <input data-testid="plugin-search" placeholder={`搜索 ${entries.length} 款插件…`} value={q} onChange={e => setQ(e.target.value)} />
        </label>
        <select className="select" data-testid="plugin-sort" value={sort} onChange={e => setSort(e.target.value as Sort)}>
          <option value="name-asc">名称 (A-Z)</option>
          <option value="name-desc">名称 (Z-A)</option>
          <option value="updated">最近更新</option>
        </select>
        <select className="select" data-testid="plugin-status" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="all">全部状态</option>
          <option value="installed">已安装</option>
          <option value="none">未安装</option>
          <option value="update">可更新</option>
        </select>
        <div className="px-view">
          <button className={view === "grid" ? "on" : ""} title="卡片" data-testid="plugin-view-grid" onClick={() => setView("grid")}>
            <Icon name="grid" size={14} />
          </button>
          <button className={view === "list" ? "on" : ""} title="列表" data-testid="plugin-view-list" onClick={() => setView("list")}>
            <Icon name="list" size={14} />
          </button>
        </div>
        <button className="btn sm icon" title="重新获取插件目录" data-testid="plugin-refresh" disabled={loading} onClick={() => reload(true)}>
          {loading ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
        </button>
      </div>

      {msg && (
        <div className={`px-msg ${msg.ok ? "ok" : "bad"}`} data-testid="plugin-msg">
          {msg.text}
        </div>
      )}
      {market?.errors.map(e => (
        <div className="px-msg bad" key={e.source + e.error} data-testid="plugin-source-error">
          {e.source}：{e.error}
        </div>
      ))}

      {!market && <div className="wb-empty">{loading ? "正在加载插件…" : "没有数据"}</div>}
      {market && shown.length === 0 && <div className="wb-empty">{entries.length === 0 ? "没有获取到插件目录" : "没有匹配的插件"}</div>}

      <div className={`px-list ${view}`} data-testid="plugin-list">
        {shown.map(e => {
          const st = stateOf(e);
          const b = busy.has(e.key);
          const noPkg = e.install.kind === "dbx" && !e.install.url;
          return (
            <div key={e.key} className="px-card" data-testid="plugin-card" data-key={e.key} data-state={st}>
              <div className="px-card-head">
                <Avatar name={e.name} />
                <div className="px-card-title">
                  <div className="px-name">
                    {e.name}
                    {st !== "none" && <span className="px-installed">已安装</span>}
                  </div>
                  <div className="px-by">{e.author ?? "未知作者"}</div>
                </div>
                <div className="px-links">
                  {e.repo && (
                    <a className="px-ico" href={e.repo} target="_blank" rel="noreferrer" title="源码仓库" data-testid="plugin-repo">
                      <Icon name="repo" size={14} />
                    </a>
                  )}
                  {e.homepage && (
                    <a className="px-ico" href={e.homepage} target="_blank" rel="noreferrer" title="主页" data-testid="plugin-home">
                      <Icon name="globe" size={14} />
                    </a>
                  )}
                </div>
              </div>
              <div className="px-tags">
                {e.tags.slice(0, 4).map(t => (
                  <span className="px-tag" key={t}>
                    {t}
                  </span>
                ))}
                {e.tags.length > 4 && <span className="px-tag">+{e.tags.length - 4}</span>}
              </div>
              <div className="px-desc" title={e.description}>
                {e.description}
              </div>
              <div className="px-foot">
                <div className="px-meta">
                  <div>{[verText(e.version), e.license, dateText(e.updated)].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="px-actions">
                  {st !== "installed" && noPkg && (
                    <span className="px-nopkg" data-testid="plugin-nopkg" title="这个插件的作者没有发布当前系统的安装包，所以现在装不了（不是软件的问题）；作者发布后会自动变成可安装">
                      暂无 {PLATFORM_NAME} 版
                    </span>
                  )}
                  {st !== "installed" && !noPkg && (
                    <button className={`btn sm ${st === "update" ? "primary" : "px-install"}`} data-testid="plugin-install" disabled={b} title="下载并安装到本软件" onClick={() => void install(e)}>
                      {b ? <span className="spinner" /> : st === "update" ? "更新" : "安装"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
