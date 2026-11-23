import { useCallback, useEffect, useState } from "react";
import type { PluginAiInfo } from "../../../../shared/pluginhost";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { Switch } from "../settings/Projects";
import { Msg } from "./common";

/** 「让 AI 使用插件」的列表：不挑插件，凡是声明了 AI 工具的已装插件都在这里，逐个开关 */
export function AiPlugins() {
  const [list, setList] = useState<PluginAiInfo[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setBusy(true);
    api
      .pluginAiList()
      .then(l => (setList(l), setErr("")))
      .catch(e => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);
  useEffect(load, [load]);

  const toggle = async (p: PluginAiInfo, on: boolean) => {
    setList(l => (l ?? []).map(x => (x.id === p.id ? { ...x, enabled: on } : x)));
    try {
      await api.pluginAiSet(p.id, on);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      load();
    }
  };

  const trust = async (p: PluginAiInfo) => {
    try {
      await api.pluginTrust(p.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    load();
  };

  if (!list) return <div className="px-hint" style={{ marginTop: 10 }}>{err || "正在读取…"}</div>;
  return (
    <div style={{ marginTop: 10 }} data-testid="ai-plugins">
      {list.length === 0 && (
        <div className="px-hint" data-testid="ai-plugins-empty">
          还没有装可以给 AI 用的插件。装了带 AI 工具的插件（DBX 插件清单里有 mcp 一项，比如 XXL-JOB；或 DSH 插件）后，会出现在这里。Codex / Claude 的插件包装的是技能、MCP、命令、规则，在对应的设置页里，不在这里。
        </div>
      )}
      <div className="prepo-list ai-plugin-scroll" data-testid="ai-plugins-scroll">
        {list.map(p => (
          <div key={p.id} className={`prepo-row ${p.enabled ? "" : "off"}`} data-testid="ai-plugin-row" data-id={p.id} style={{ alignItems: "flex-start" }}>
            <div className="prepo-main">
              <b>
                {p.name} <span className="px-hint">v{p.version}</span>
              </b>
              <span className="px-hint">
                {p.ecosystem === "dsh" ? <span className="px-eco eco-dsh">DSH 插件</span> : null}{" "}
                {p.trusted ? (p.error ? "读取工具失败" : `${p.tools.length} 个 AI 工具（${p.tools.filter(t => t.readOnly).length} 个只读）`) : p.ecosystem === "dsh" ? "还没确认信任：确认后才会运行它，并读取它的 AI 工具" : "还没确认信任：到右侧插件栏打开它并确认后，才能读取它的 AI 工具"}
                {p.connKind ? ` · 需要「设置 → 连接」里的 ${p.connKind} 连接（现有 ${p.connCount} 个）` : ""}
              </span>
              {!p.trusted && p.ecosystem === "dsh" && (
                <div className="px-msg warn" data-testid="ai-plugin-trust">
                  DSH 插件是第三方的 JavaScript 程序，运行后能访问你电脑上的文件和网络。只在你信任它的作者时才确认；以后更新到新版本还会再问一次。
                  <div style={{ marginTop: 6 }}>
                    <button className="btn sm primary" data-testid="ai-plugin-trust-btn" disabled={busy} onClick={() => void trust(p)}>
                      确认信任并运行
                    </button>
                  </div>
                </div>
              )}
              {p.error && (
                <Msg className="px-msg bad" stamp={p} data-testid="ai-plugin-err">
                  {p.error}
                </Msg>
              )}
              {p.enabled && p.connKind && p.connCount === 0 && (
                <Msg className="px-msg warn" stamp={p} data-testid="ai-plugin-noconn">
                  还没有可用的连接，AI 调用时会提示去「设置 → 连接」添加。
                </Msg>
              )}
              {p.tools.length > 0 && (
                <details data-testid="ai-plugin-tools">
                  <summary className="px-hint">查看工具</summary>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {p.tools.map(t => (
                      <li key={t.name}>
                        <span className="mono">{t.name}</span> {t.readOnly ? "" : "（会改东西，每次需你批准）"} <span className="px-hint">{t.description}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <Switch on={p.enabled} testid="ai-plugin-switch" onChange={v => void toggle(p, v)} />
          </div>
        ))}
      </div>
      {err && (
        <Msg className="px-msg bad" style={{ marginTop: 10 }} data-testid="ai-plugins-err">
          {err}
        </Msg>
      )}
      <div className="px-set-row" style={{ marginTop: 10 }}>
        <button className="btn sm" data-testid="ai-plugins-refresh" disabled={busy} onClick={load}>
          {busy ? <span className="spinner" /> : <Icon name="refresh" size={13} />} 重新读取
        </button>
      </div>
    </div>
  );
}
