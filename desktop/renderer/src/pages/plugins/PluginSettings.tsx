import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppState } from "../../../../shared/api";
import { PRESET_REPOS, type MarketResult, type PluginRepo } from "../../../../shared/plugins";
import { api } from "../../api";
import { Icon, type IconName } from "../../components/Icon";
import { Req, useRequired } from "../../components/Required";
import type { PackageInstall } from "../../lib/pkgInstall";
import { AiPlugins } from "./AiPlugins";
import { Msg } from "./common";

function Card({ icon, title, desc, right, children, testid }: { icon: IconName; title: string; desc: ReactNode; right?: ReactNode; children?: ReactNode; testid?: string }) {
  return (
    <section className="px-set" data-testid={testid}>
      <div className="px-set-head">
        <span className="px-set-icon">
          <Icon name={icon} size={16} />
        </span>
        <div className="px-set-title">
          <h3>{title}</h3>
          <p>{desc}</p>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

const Fact = ({ k, children }: { k: string; children: ReactNode }) => (
  <>
    <span>{k}</span>
    <b>{children}</b>
  </>
);

/** 插件中心的「设置」：本软件已装插件、让 AI 使用插件的开关、插件仓库 */
export function PluginSettings({ state, onChanged, market, loading, reload, pkg }: { state: AppState; onChanged: () => void; market: MarketResult | null; loading: boolean; reload: (refresh?: boolean, silent?: boolean) => void; pkg: PackageInstall }) {
  const [repos, setRepos] = useState<PluginRepo[]>([]);
  const [repoErr, setRepoErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const req = useRequired();
  const [form, setForm] = useState({ id: "", name: "", url: "" });
  const [pkgUrl, setPkgUrl] = useState("");
  const [devOpen, setDevOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadRepos = useCallback(() => void api.pluginRepos().then(setRepos).catch(() => {}), []);
  useEffect(loadRepos, [loadRepos]);
  const countOf = (name: string) => (market?.entries ?? []).filter(e => e.source === name).length;
  const repoAct = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    setRepoErr(r.ok ? "" : (r.error ?? "操作失败"));
    loadRepos();
    if (r.ok) reload(true);
    return r.ok;
  };
  const testRepo = async () => {
    const miss = req.check([{ key: "url", label: "仓库地址", ok: !!form.url.trim() }]);
    if (miss) return setRepoErr(miss);
    setRepoErr("");
    setTestMsg(null);
    setTesting(true);
    try {
      const r = await api.pluginRepoTest({ name: form.name, url: form.url });
      if (!r.ok) return setTestMsg({ ok: false, text: `测试失败：${r.error ?? "未知原因"}` });
      const n = r.count ?? 0;
      setTestMsg({ ok: true, text: n ? `测试成功：能读到插件目录，共 ${n} 个插件${r.names?.length ? `（${r.names.join("、")}${n > r.names.length ? " 等" : ""}）` : ""}。` : "测试成功：仓库连得上，但里面还没有插件。" });
    } catch (e) {
      setTestMsg({ ok: false, text: `测试失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setTesting(false);
    }
  };
  const saveRepo = async () => {
    const miss = req.check([{ key: "url", label: "仓库地址", ok: !!form.url.trim() }]);
    if (miss) return setRepoErr(miss);
    setSaving(true);
    try {
      if (await repoAct(api.pluginRepoAdd(form))) {
        setForm({ id: "", name: "", url: "" });
        setAdding(false);
      }
    } finally {
      setSaving(false);
    }
  };
  const dbx = market?.dbx;

  return (
    <div className="px-settings" data-testid="plugin-settings">
      <Card icon="upload" title="安装插件包" desc="从本地文件或链接安装插件商店之外的 .dbxp 插件包。.dbxp 是插件的打包格式（遵循 DBX 公开的插件规范），任何人都能按这个规范做插件，不需要安装 DBX 软件。DSH、Codex 的插件不用在这里装：把它们的插件仓库加到下面的「插件仓库」，就能在插件商店里装。本软件会校验包内文件的完整性，暂不验证作者签名，所以只装你信任的来源。" testid="pkg-install">
        <div className="px-set-row" style={{ marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn" data-testid="pkg-pick" disabled={pkg.busy} onClick={() => fileRef.current?.click()}>
            {pkg.busy ? <span className="spinner" /> : <Icon name="upload" size={14} />} 安装 .dbxp
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".dbxp"
            multiple
            hidden
            data-testid="pkg-file"
            onChange={e => {
              void pkg.files([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <span className="px-hint">
            <Icon name="shield" size={13} /> 校验包内文件完整性
          </span>
          <span className="px-hint">
            <Icon name="upload" size={13} /> 也可拖放 .dbxp 到插件中心页面安装
          </span>
        </div>
        <div className="px-set-row" style={{ marginTop: 10 }}>
          <label className="px-urlbox">
            <Icon name="link" size={14} />
            <input data-testid="pkg-url" placeholder="https://example.com/plugin.dbxp" value={pkgUrl} onChange={e => setPkgUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && void pkg.url(pkgUrl).then(ok => ok && setPkgUrl(""))} />
          </label>
          <button className="btn" data-testid="pkg-url-install" disabled={pkg.busy || !pkgUrl.trim()} onClick={() => void pkg.url(pkgUrl).then(ok => ok && setPkgUrl(""))}>
            <Icon name="download" size={14} /> 从 URL 安装
          </button>
        </div>
        {pkg.msg && (
          <Msg className={`px-msg ${pkg.msg.ok ? "ok" : "bad"}`} style={{ marginTop: 10 }} data-testid="pkg-msg">
            {pkg.msg.text}
          </Msg>
        )}
      </Card>

      <Card
        icon="store"
        title="插件仓库"
        desc="商店里的插件都来自已启用的仓库。支持 DBX、Codex / Claude、DSH 三种插件仓库，填 GitHub 链接（或 owner/repo）或目录文件直链即可，预置的也能停用、删除。"
        testid="dbx-catalog"
        right={
          <button
            className="btn sm"
            data-testid="repo-add"
            onClick={() => {
              setRepoErr("");
              setTestMsg(null);
              req.reset();
              setAdding(a => !a);
            }}
          >
            <Icon name={adding ? "x" : "plus"} size={13} /> {adding ? "取消添加" : "添加仓库"}
          </button>
        }
      >
        {adding && (
          <div className="prepo-form" data-testid="repo-form">
            <label className="prepo-field">
              <span>
                仓库名称 <i>（可不填）</i>
              </span>
              <input className="input" data-testid="repo-f-name" placeholder="例如：我的插件仓库" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="prepo-field">
              <span>
                代号 <i>（可不填，自动生成）</i>
              </span>
              <input className="input" data-testid="repo-f-id" title="内部用的简短代号（小写字母、数字、-、_）。不填会自动生成，一般不用管。" placeholder="例如：my-repo" value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} />
            </label>
            {PRESET_REPOS.some(p => !repos.some(r => r.url === p.url)) && (
              <div className="prepo-presets wide" data-testid="repo-presets">
                <span className="px-hint">常用仓库：</span>
                {PRESET_REPOS.filter(p => !repos.some(r => r.url === p.url)).map(p => (
                  <button key={p.url} type="button" className="btn sm" data-testid="repo-preset" title={p.desc} onClick={() => setForm({ ...form, name: form.name || p.name, url: p.url })}>
                    <Icon name="plus" size={12} /> {p.name}
                  </button>
                ))}
              </div>
            )}
            <label className="prepo-field wide">
              <span>
                仓库地址 <Req />
              </span>
              <input className={req.cls("url")} data-req="url" data-testid="repo-f-url" placeholder="GitHub 仓库链接（或 owner/repo），或插件目录文件的直链" value={form.url} onChange={e => (setForm({ ...form, url: e.target.value }), req.clear("url"), setTestMsg(null))} onKeyDown={e => e.key === "Enter" && void saveRepo()} />
            </label>
            {repoErr && (
              <Msg className="px-msg bad wide" data-testid="repo-err">
                {repoErr}
              </Msg>
            )}
            {testMsg && (
              <Msg className={`px-msg ${testMsg.ok ? "ok" : "bad"} wide`} data-testid="repo-test-msg">
                {testMsg.text}
              </Msg>
            )}
            <div className="prepo-actions wide">
              <button className="btn" data-testid="repo-save" disabled={saving || testing} onClick={() => void saveRepo()}>
                {saving ? <span className="spinner" /> : <Icon name="check" size={14} />} 保存
              </button>
              <button className="btn" data-testid="repo-test" disabled={saving || testing} onClick={() => void testRepo()}>
                {testing ? <span className="spinner" /> : <Icon name="refresh" size={14} />} 测试
              </button>
              <button className="btn" data-testid="repo-cancel" onClick={() => (setAdding(false), setRepoErr(""), setTestMsg(null), req.reset())}>
                取消
              </button>
            </div>
          </div>
        )}
        <div className="prepo-list" style={{ marginTop: 12 }}>
          {repos.length === 0 && (
            <div className="px-hint" data-testid="repo-empty">
              还没有仓库。点右上角「添加仓库」，粘贴一个 GitHub 仓库链接就行。
            </div>
          )}
          {repos.map(r => (
            <div key={r.id} className={`prepo-row ${r.enabled ? "" : "off"}`} data-testid="repo-row" data-id={r.id}>
              <div className="prepo-main">
                <b>{r.name}</b>
                <span className="mono">{r.url}</span>
                <span className="px-hint">
                  <span data-testid="repo-count">{r.enabled ? `${countOf(r.name)} 个插件` : "已停用"}</span>
                </span>
              </div>
              <button className={`btn sm${r.enabled ? "" : " primary"}`} data-testid="repo-toggle" title={r.enabled ? "停用后，商店里不再显示这个仓库的插件" : "启用后，商店里会显示这个仓库的插件"} onClick={() => void repoAct(api.pluginRepoToggle(r.id, !r.enabled))}>
                {r.enabled ? "停用" : "启用"}
              </button>
              <button className="btn sm icon" title="删除仓库" data-testid="repo-del" onClick={() => void repoAct(api.pluginRepoRemove(r.id))}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
        {!adding && repoErr && (
          <Msg className="px-msg bad" style={{ marginTop: 10 }} data-testid="repo-err">
            {repoErr}
          </Msg>
        )}
        {(market?.errors ?? []).filter(e => repos.some(r => r.name === e.source)).map(e => (
          <Msg className="px-msg warn" style={{ marginTop: 10 }} key={e.source} stamp={market} data-testid="repo-load-err">
            {e.error}
          </Msg>
        ))}
        <div className="px-set-row" style={{ marginTop: 10 }}>
          <button className="btn sm" data-testid="dbx-recheck" disabled={loading} onClick={() => reload(true)}>
            {loading ? <span className="spinner" /> : <Icon name="refresh" size={13} />} 重新检测并刷新目录
          </button>
        </div>
      </Card>

      <section className="px-set" data-testid="dev-options">
        <button className="px-set-head px-fold" data-testid="dev-toggle" onClick={() => setDevOpen(o => !o)}>
          <span className="px-set-icon">
            <Icon name="sliders" size={16} />
          </span>
          <div className="px-set-title">
            <h3>第三方与开发者选项</h3>
            <p>接入第三方仓库或开发本地插件时使用。</p>
          </div>
          <Icon name={devOpen ? "down" : "right"} size={15} />
        </button>
        {devOpen && (
          <div style={{ marginTop: 10 }}>
            <div className="px-facts">
              <Fact k="插件安装目录">
                <span className="mono" data-testid="plugin-dir">
                  {dbx?.dir ?? "—"}
                </span>
              </Fact>
              <Fact k="第三方仓库">DBX 插件的下载地址由所在仓库指定（你添加仓库就是信任它），安装前仍会核对目录里的 sha256；同一个 DBX 插件 ID 出现在多个仓库时，排在前面的仓库优先。</Fact>
              <Fact k="本地开发">把插件按 plugins/&lt;id&gt;/versions/&lt;版本&gt;/ 放进上面的目录，刷新后就会出现在「已安装」和右侧插件栏。</Fact>
            </div>
            <div className="px-set-row" style={{ marginTop: 10 }}>
              <button className="btn sm" data-testid="plugin-open-dir" onClick={() => void api.pluginOpenDir()}>
                <Icon name="folder" size={13} /> 打开插件目录
              </button>
            </div>
          </div>
        )}
      </section>

      <Card icon="bot" title="让 AI 使用插件" desc="已装的插件如果自带 AI 工具（DBX 插件清单里有 mcp 一项，或是 DSH 插件注册的工具），可以在这里逐个允许 AI 使用。工具由本软件直接调用插件的后台程序，不需要 DBX；DSH 插件是第三方 JavaScript，要先在这里确认信任才会运行；只读工具 AI 直接用，会改东西的每次都要你批准。连接类插件用「设置 → 连接」里的连接。" testid="ai-plugins-card">
        <AiPlugins />
      </Card>

    </div>
  );
}
