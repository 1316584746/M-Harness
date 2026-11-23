import { useEffect, useMemo, useState } from "react";
import { ECOSYSTEM_LABEL, type Ecosystem, type MarketResult, type PluginEntry } from "../../../../shared/plugins";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { Avatar, dateText, haveVersions, Msg, verText } from "./common";

type St = "none" | "installed" | "update";

/** 插件商店：所有已启用仓库里的插件（.dbxp）。搜索、按状态筛选、卡片 / 列表，点安装直接装进本软件。技能 / MCP 这类不是插件，不在这里 */
const PLATFORM_NAME = /Mac/i.test(navigator.platform) ? "macOS" : /Linux/i.test(navigator.platform) ? "Linux" : "Windows";

export function Store({ market, loading, reload }: { market: MarketResult | null; loading: boolean; reload: (refresh?: boolean, silent?: boolean) => void }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [eco, setEco] = useState("all");
  /** 用户选的插件库（按库的显示名）；没选 / 选的库已被停用 = 第一个已启用的库 */
  const [libPick, setLibPick] = useState(() => localStorage.getItem("harness.plugins.lib") ?? "");
  /** 设置里「插件仓库」的启用情况和顺序 */
  const [repoNames, setRepoNames] = useState<string[]>([]);
  /** 一次最多画这么多张卡片（DSH 市场有近千个插件） */
  const [limit, setLimit] = useState(120);
  const [view, setView] = useState<"grid" | "list">(() => (localStorage.getItem("harness.plugins.view") === "list" ? "list" : "grid"));
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const entries = market?.entries ?? [];
  const local = useMemo(() => haveVersions(market), [market]);
  useEffect(() => localStorage.setItem("harness.plugins.view", view), [view]);
  useEffect(() => setLimit(120), [q, status, eco, libPick]);
  useEffect(() => localStorage.setItem("harness.plugins.lib", libPick), [libPick]);
  useEffect(() => {
    let alive = true;
    void api
      .pluginRepos()
      .then(rs => alive && setRepoNames(rs.filter(r => r.enabled).map(r => r.name)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [market]);  useEffect(() => {
    if (!msg?.ok) return;
    const t = setTimeout(() => setMsg(null), 8000);
    return () => clearTimeout(t);
  }, [msg]);

  /** 可选的插件库：设置里已启用的（按那边的顺序），再加上目录里出现过但不在仓库列表里的（如软件推荐）；值是插件数 */
  const libList = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of entries) n.set(e.source, (n.get(e.source) ?? 0) + 1);
    const names = [...repoNames, ...[...n.keys()].filter(k => !repoNames.includes(k))];
    return names.map(k => [k, n.get(k) ?? 0] as const);
  }, [entries, repoNames]);
  /** 当前生效的库：用户选的（仍然启用）否则第一个 */
  const lib = libList.some(([x]) => x === libPick) ? libPick : (libList[0]?.[0] ?? "");
  const libEntries = useMemo(() => entries.filter(e => e.source === lib), [entries, lib]);
  const stateOf = (e: PluginEntry): St => {
    const v = local[e.install.kind === "dbx" ? e.install.dbxId : e.id];
    return v === undefined ? "none" : e.version && v && v !== e.version ? "update" : "installed";
  };
  const ecoOf = (e: PluginEntry): Ecosystem => e.ecosystem ?? "dbx";
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    const list = libEntries.filter(e => {
      const st = stateOf(e);
      const stOk = status === "all" || (status === "installed" ? st !== "none" : status === "none" ? st === "none" : st === "update");
      return stOk && e.source === lib && (eco === "all" || ecoOf(e) === eco) && (!k || [e.name, e.id, e.author ?? "", e.description, e.tags.join(" "), e.source].join(" ").toLowerCase().includes(k));
    });
    return list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }, [libEntries, q, status, eco, local, lib]);
  /** 目录里出现了哪几家的插件（只有一家时不显示筛选） */
  const ecosystems = useMemo(() => [...new Set(libEntries.map(ecoOf))], [libEntries]);

  const install = async (e: PluginEntry) => {
    if (e.install.kind === "dbx" && !e.install.url) return;
    setMsg(null);
    setBusy(b => new Set([...b, e.key]));
    const r = await api.pluginInstall(e.install.kind === "dbx" ? e.install.dbxId : e.id);
    setBusy(b => new Set([...b].filter(k => k !== e.key)));
    if (r.ok) {
      const dsh = e.install.kind === "dsh" ? "。到「让 AI 使用插件」里确认信任并开启后，AI 才能用它的工具" : e.install.kind === "bundle" ? "。里面的技能、MCP、动作、规则已经装进本软件，可到对应的设置页查看" : "";
      setMsg({ ok: true, text: `已安装「${e.name}」${verText(r.version)}${dsh}${r.note ? `。${r.note}` : ""}${r.error ? `。${r.error}` : ""}` });
      reload(false, true);
    } else setMsg({ ok: false, text: `安装「${e.name}」失败：${r.error ?? "未知错误"}` });
  };

  return (
    <div className="pstore" data-testid="plugin-store">
      <div className="px-toolbar">
        <label className="px-search">
          <Icon name="search" size={14} />
          <input data-testid="plugin-search" placeholder={`搜索 ${libEntries.length} 款插件…`} value={q} onChange={e => setQ(e.target.value)} />
        </label>
        {libList.length > 0 && (
          <select className="select px-lib-sel" data-testid="plugin-lib" title="选择要看哪个插件库；不选就是第一个已启用的库。增加、停用插件库到本页「设置」里的「插件仓库」" value={lib} onChange={e => setLibPick(e.target.value)}>
            {libList.map(([name, n]) => (
              <option key={name} value={name}>
                {name}（{n}）
              </option>
            ))}
          </select>
        )}
        <select className="select" data-testid="plugin-status" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="all">全部状态</option>
          <option value="installed">已安装</option>
          <option value="none">未安装</option>
          <option value="update">可更新</option>
        </select>
        {ecosystems.length > 1 && (
          <select className="select" data-testid="plugin-eco" value={eco} onChange={e => setEco(e.target.value)}>
            <option value="all">全部类型</option>
            {ecosystems.map(x => (
              <option key={x} value={x}>
                {ECOSYSTEM_LABEL[x]}
              </option>
            ))}
          </select>
        )}
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
        <Msg className={`px-msg ${msg.ok ? "ok" : "bad"}`} data-testid="plugin-msg">
          {msg.text}
        </Msg>
      )}
      {eco === "dsh" && (
        <div className="px-msg warn" data-testid="plugin-dsh-hint">
          DSH 市场里多数插件是给 DSH 自己用的（界面主题、会话管理、模型提供方等），本软件只能用其中提供 AI 工具或命令的一小部分——实测抽样 60 多个，能用的不到十分之一。常见装不上 / 用不了的原因：依赖 DSH 内部服务；是只有界面的主题；源码仓库没编译；标「未验证」的条目其实是技能或文档仓库（技能可到「设置 → 技能 → 从 GitHub 导入」）。明显不能用的会在安装时直接拒绝；其余装好、确认信任、运行后才知道，原因会写在「让 AI 使用插件」里。
        </div>
      )}
      {market?.errors.map(e => (
        <Msg className="px-msg bad" key={e.source + e.error} stamp={market} data-testid="plugin-source-error">
          {e.source}：{e.error}
        </Msg>
      ))}

      {!market && <div className="wb-empty">{loading ? "正在加载插件…" : "没有数据"}</div>}
      {market && shown.length === 0 && <div className="wb-empty">{entries.length === 0 ? "没有获取到插件目录" : "没有匹配的插件"}</div>}

      <div className={`px-list ${view}`} data-testid="plugin-list">
        {shown.slice(0, limit).map(e => {
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
                    {e.ecosystem && (
                      <span className={`px-eco eco-${e.ecosystem}`} data-testid="plugin-eco-tag">
                        {ECOSYSTEM_LABEL[e.ecosystem]}
                      </span>
                    )}
                    {st !== "none" && <span className="px-installed">已安装</span>}
                  </div>
                  <div className="px-by">
                    {e.author ?? "未知作者"} · {e.source}
                  </div>
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
                  {e.note && (
                    <div className="px-fnote" data-testid="plugin-note" title={e.note}>
                      {e.note}
                    </div>
                  )}
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
      {shown.length > limit && (
        <div style={{ textAlign: "center", margin: "12px 0" }}>
          <button className="btn sm" data-testid="plugin-more" onClick={() => setLimit(n => n + 120)}>
            再显示 120 个（还有 {shown.length - limit} 个，也可以用搜索缩小范围）
          </button>
        </div>
      )}
    </div>
  );
}
