import { useEffect, useRef, useState } from "react";
import type { AppState } from "../../../shared/api";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { useConfigEditor } from "../lib/configEdit";
import { Switch } from "./settings/Projects";

/** 飞书消息通道：启停 + 允许谁来驱动它（lark-cli 长连接，无需公网地址） */
export function FeishuChannel({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const lark = ed.cfg?.channels?.larkCli as { allowUsers?: string[]; groupRequireMention?: boolean; replyFormat?: string; notifyOnline?: boolean } | undefined;
  const enabled = !!lark;
  const running = state.channel.running;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newUser, setNewUser] = useState("");
  const users = lark?.allowUsers ?? [];

  const save = async (fn: (c: Record<string, any>) => void) => {
    setError("");
    const r = await ed.update(fn);
    if (!r.ok) setError(r.error ?? "保存失败");
    return r.ok;
  };

  const toggleChannel = async () => {
    setBusy(true);
    setError("");
    if (running) await api.channelStop();
    else {
      const r = await api.channelStart();
      if (!r.ok) setError(r.error ?? "启动失败");
    }
    onChanged();
    setBusy(false);
  };

  const addUser = async (id: string) => {
    const v = id.trim();
    if (!v) return;
    if (!/^ou_[\w]+$/.test(v)) return setError("open_id 形如 ou_xxxxxxxx");
    if (users.includes(v)) return setNewUser("");
    if (await save(c => void (c.channels.larkCli.allowUsers = [...(c.channels.larkCli.allowUsers ?? []), v]))) setNewUser("");
  };

  const addMe = async () => {
    const s = await api.integrationStatus("lark");
    if (!s.openId) return setError(s.detail ?? "没有读到你的 open_id，请先执行 lark-cli auth login");
    await addUser(s.openId);
  };

  return (
    <>
      <div className="channel-card" data-testid="feishu-channel-card">
        <div className="channel-logo feishu">
          <Icon name="chat" size={22} />
        </div>
        <div className="channel-main">
          <div className="channel-name">
            飞书消息通道
            {enabled && (
              <span className={`chip ${running ? "ok" : ""}`}>
                <span className={`dot ${running ? "ok" : ""}`} />
                {running ? "运行中" : "已停止"}
              </span>
            )}
          </div>
          <div className="muted">在飞书里和机器人聊天驱动模型，默认只读。</div>
        </div>
        {enabled && (
          <button className={`btn ${running ? "" : "primary"}`} disabled={busy} onClick={toggleChannel} data-testid="channel-toggle">
            {running ? "停止" : "启动"}
          </button>
        )}
        <Switch
          on={enabled}
          testid="channel-switch"
          onChange={v =>
            void (async () => {
              if (!v && running) await api.channelStop();
              await save(c => {
                c.channels ??= {};
                if (v) c.channels.larkCli = { bin: "lark-cli", allowUsers: [] };
                else delete c.channels.larkCli;
              });
            })()
          }
        />
      </div>

      {enabled && (
        <div className="sgroup" style={{ marginBottom: 12 }}>
          <div className="srow" style={{ alignItems: "flex-start" }}>
            <div className="srow-text">
              <div className="srow-title">允许的用户</div>
              <div className="srow-desc">{users.length === 0 ? <b style={{ color: "var(--warn)" }}>未设置，任何人都能驱动它</b> : "飞书 open_id"}</div>
              <div className="chips" data-testid="allow-users">
                {users.map(u => (
                  <span key={u} className="chip">
                    <code>{u}</code>
                    <button className="chip-x" title="移除" onClick={() => void save(c => void (c.channels.larkCli.allowUsers = users.filter(x => x !== u)))}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
            <div className="srow-ctl" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
              <button className="btn sm" data-testid="allow-me" onClick={() => void addMe()}>
                <Icon name="user" size={13} /> 添加我自己
              </button>
              <div className="inputrow">
                <input className="input mono" data-testid="allow-input" style={{ width: 200 }} value={newUser} placeholder="ou_xxxxxxxx" onChange={e => setNewUser(e.target.value)} onKeyDown={e => e.key === "Enter" && void addUser(newUser)} />
                <button className="btn sm" data-testid="allow-add" onClick={() => void addUser(newUser)}>
                  添加
                </button>
              </div>
            </div>
          </div>
          <div className="srow">
            <div className="srow-text">
              <div className="srow-title">打开软件时提醒我</div>
              <div className="srow-desc">每次打开 M-Harness，由你自己的飞书机器人给你本人发一条「已上线」（时间、电脑名、版本）。只发给你，不发给别人。</div>
            </div>
            <div className="srow-ctl">
              <Switch on={lark?.notifyOnline ?? true} testid="channel-notify-online" onChange={v => void save(c => void (c.channels.larkCli.notifyOnline = v))} />
            </div>
          </div>
          <div className="srow">
            <div className="srow-text">
              <div className="srow-title">群聊需要 @ 机器人</div>
            </div>
            <div className="srow-ctl">
              <Switch on={lark?.groupRequireMention ?? true} testid="channel-mention" onChange={v => void save(c => void (c.channels.larkCli.groupRequireMention = v))} />
            </div>
          </div>
          <div className="srow">
            <div className="srow-text">
              <div className="srow-title">回复格式</div>
            </div>
            <div className="srow-ctl">
              <select className="input" value={lark?.replyFormat ?? "markdown"} onChange={e => {
                const v = e.target.value; // 先取值：保存是异步的，等会儿再读 e.target 会拿到被界面还原的旧值
                void save(c => void (c.channels.larkCli.replyFormat = v));
              }}>
                <option value="markdown">Markdown</option>
                <option value="text">纯文本</option>
              </select>
            </div>
          </div>
        </div>
      )}
      {error && <div className="inline-warn">{error}</div>}
    </>
  );
}

/** 钉钉：消息通道与项目管理都还没接入，先占位 */
export function DingTalkPlaceholders() {
  return (
    <>
      <div className="channel-card dim">
        <div className="channel-logo ding">
          <Icon name="plug" size={22} />
        </div>
        <div className="channel-main">
          <div className="channel-name">
            钉钉消息通道 <span className="chip">待接入</span>
          </div>
          <div className="muted">钉钉消息通道：开发中</div>
        </div>
      </div>
    </>
  );
}

export function ChannelLogs({ state }: { state: AppState }) {
  const [logs, setLogs] = useState<string[]>(state.channel.logs);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => api.onChannelLog(l => setLogs(ls => [...ls.slice(-499), l])), []);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs]);
  return (
    <>
      <div className="section-title">通道运行日志</div>
      <pre className="log" ref={box}>
        {logs.length ? logs.join("\n") : "（暂无日志）"}
      </pre>
    </>
  );
}
