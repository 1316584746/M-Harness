import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppState } from "../../../../shared/api";
import { DBX_MCP_NAME, type MarketResult, type PluginRepo } from "../../../../shared/plugins";
import { api } from "../../api";
import { Icon, type IconName } from "../../components/Icon";
import { useDbxBridge } from "../../lib/dbxBridge";
import type { PackageInstall } from "../../lib/pkgInstall";
import { Switch } from "../settings/Projects";

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

/** 插件中心的「设置」：本软件已装插件、本机 DBX 的连接情况、让 AI 使用 DBX 插件的桥接、插件目录来源 */
export function PluginSettings({ state, onChanged, market, loading, reload, pkg }: { state: AppState; onChanged: () => void; market: MarketResult | null; loading: boolean; reload: (refresh?: boolean, silent?: boolean) => void; pkg: PackageInstall }) {
  const bridge = useDbxBridge(state, onChanged, market);
  const [err, setErr] = useState("");
  const [repos, setRepos] = useState<PluginRepo[]>([]);
  const [repoErr, setRepoErr] = useState("");
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
  const dbx = market?.dbx;
  const n = Object.keys(dbx?.plugins ?? {}).length;
  const nl = Object.keys(dbx?.local ?? {}).length;
  const server = (JSON.parse(state.configText.replace(/^\uFEFF/, "") || "{}")?.mcpServers?.[DBX_MCP_NAME] ?? null) as { command?: string; args?: string[] } | null;
  const cmd = server?.command ?? dbx?.mcp?.command;

  return (
    <div className="px-settings" data-testid="plugin-settings">
      <Card icon="upload" title="安装插件包" desc="从本地文件或链接安装插件商店之外的 .dbxp 插件包。本软件会校验包内文件的完整性，暂不验证作者签名，所以只装你信任的来源。" testid="pkg-install">
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
          <div className={`px-msg ${pkg.msg.ok ? "ok" : "bad"}`} style={{ marginTop: 10 }} data-testid="pkg-msg">
            {pkg.msg.text}
          </div>
        )}
      </Card>

      <Card icon="store" title="插件仓库" desc="官方仓库和 DBX 里看到的是同一份；也可以添加自托管或第三方仓库（一份 DBX 格式的 catalog/index.json）。" testid="dbx-catalog">
        <div className="prepo-list" style={{ marginTop: 12 }}>
          {repos.map(r => (
            <div key={r.id} className={`prepo-row ${r.enabled ? "" : "off"}`} data-testid="repo-row" data-id={r.id}>
              <div className="prepo-main">
                <b>
                  {r.name} {r.official && <span className="px-pill on">官方</span>}
                </b>
                <span className="mono">{r.url}</span>
                <span className="px-hint" data-testid="repo-count">
                  {r.enabled ? `${countOf(r.name)} 个插件` : "已停用"}
                </span>
              </div>
              {r.official ? (
                <span className="px-pill on">已启用</span>
              ) : (
                <>
                  <Switch on={r.enabled} testid="repo-switch" onChange={v => void repoAct(api.pluginRepoToggle(r.id, v))} />
                  <button className="btn sm icon" title="删除仓库" data-testid="repo-del" onClick={() => void repoAct(api.pluginRepoRemove(r.id))}>
                    <Icon name="trash" size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="prepo-add" style={{ marginTop: 10 }}>
          <input className="input" data-testid="repo-f-id" placeholder="仓库 ID" value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} />
          <input className="input" data-testid="repo-f-name" placeholder="仓库名称" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input className="input" data-testid="repo-f-url" placeholder="https://plugins.example.com/catalog/index.json" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} />
          <button
            className="btn"
            data-testid="repo-add"
            disabled={!form.id.trim() || !form.url.trim()}
            onClick={async () => {
              if (await repoAct(api.pluginRepoAdd(form))) setForm({ id: "", name: "", url: "" });
            }}
          >
            <Icon name="plus" size={14} /> 添加仓库
          </button>
        </div>
        {repoErr && (
          <div className="px-msg bad" style={{ marginTop: 10 }} data-testid="repo-err">
            {repoErr}
          </div>
        )}
        {(market?.errors ?? []).filter(e => repos.some(r => r.name === e.source && !r.official)).map(e => (
          <div className="px-msg warn" style={{ marginTop: 10 }} key={e.source} data-testid="repo-load-err">
            {e.error}
          </div>
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
              <Fact k="第三方仓库">来自第三方仓库的插件，下载地址由该仓库指定，安装前仍会核对目录里的 sha256；同一个插件 ID 官方仓库优先。</Fact>
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

      <Card
        icon="plug"
        title="本机 DBX（可选）"
        desc="插件直接装在本软件里，不需要 DBX；「已安装」里只列装在本软件里的插件。本机装了 DBX 时，还可以通过 DBX 的 MCP 让 AI 调用 DBX 里的插件工具；不会改动 DBX 的文件。"
        testid="dbx-status"
        right={
          <span className={`px-pill ${dbx?.appFound ? "on" : ""}`} data-testid="dbx-found">
            {dbx?.appFound ? "已检测到" : "未检测到"}
          </span>
        }
      >
        <div className="px-facts" style={{ marginTop: 10 }}>
          <Fact k="装在本软件">
            <span data-testid="local-count">{nl} 个</span>
          </Fact>
          <Fact k="装在 DBX 里">{n} 个</Fact>
          <Fact k="MCP 组件">{dbx?.mcp ? <span className="mono">{dbx.mcp.command}</span> : "没找到（npm i -g @dbx-app/mcp-server）"}</Fact>
        </div>
      </Card>

      <Card
        icon="bot"
        title="让 AI 使用 DBX 插件"
        desc="打开后，AI 能调用 DBX 里已装插件提供的工具（比如 XXL-JOB 查询、SSH / SFTP）；写入类工具仍然每次需要你确认。使用时 DBX 需要保持运行。"
        testid="dbx-bridge"
        right={bridge.available ? <Switch on={bridge.on} testid="dbx-bridge-switch" onChange={v => void bridge.toggle(v).then(r => setErr(r.ok ? "" : (r.error ?? "保存失败")))} /> : undefined}
      >
        {!bridge.available && (
          <div className="px-msg warn" style={{ marginTop: 10 }} data-testid="dbx-bridge-missing">
            没找到 DBX 的 MCP 组件。先在命令行装一下：<code>npm i -g @dbx-app/mcp-server</code>，装好后回到这里点「重新检测」。
          </div>
        )}
        {cmd && (
          <div className="px-facts" style={{ marginTop: 10 }}>
            <Fact k="MCP 服务名">{DBX_MCP_NAME}</Fact>
            <Fact k="启动命令">
              <span className="mono">{[cmd, ...(server?.args ?? [])].join(" ")}</span>
            </Fact>
          </div>
        )}
        {err && <div className="px-msg bad" style={{ marginTop: 10 }}>{err}</div>}
      </Card>

    </div>
  );
}
