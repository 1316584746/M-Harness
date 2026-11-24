import { useEffect, useState } from "react";
import type { AppState } from "../../../../shared/api";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { useConfigEditor } from "../../lib/configEdit";
import { activePlatform, setPlatform, type OfficePlatform } from "../../lib/office";
import { ChannelLogs, DingTalkPlaceholders } from "../Channels";
import { DingTalkIntegration, FeishuIntegration } from "./Integrations";
import { DingtalkProjectSection, Switch } from "./Projects";

const INFO: Record<OfficePlatform, { name: string; desc: string; logo: string; icon: "chat" | "plug" | "settings" }> = {
  feishu: { name: "飞书", desc: "飞书消息通道 + 飞书项目管理（lark-cli / meegle）", logo: "feishu", icon: "chat" },
  dingtalk: { name: "钉钉", desc: "钉钉待办 / AI 表格项目管理（dws）", logo: "ding", icon: "plug" },
  custom: { name: "自定义", desc: "接入你们自己的办公系统：写一段使用说明，配合 MCP / 技能让模型去用", logo: "custom", icon: "settings" },
};

/** 办公集成：飞书 / 钉钉 / 自定义，各有一个启用开关，同一时间只能启用一个 */
export function Office({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const active = activePlatform(ed.cfg);
  const [err, setErr] = useState("");

  const choose = async (p: OfficePlatform, on: boolean) => {
    setErr("");
    // 离开飞书之前先停掉消息通道，不然它还在后台收消息
    if (active === "feishu" && (!on || p !== "feishu") && state.channel.running) await api.channelStop();
    const r = await ed.update(c => setPlatform(c, on ? p : null));
    if (!r.ok) setErr(r.error ?? "保存失败");
  };

  const head = (p: OfficePlatform) => (
    <div className={`channel-card ${active && active !== p ? "dim" : ""}`} data-testid={`office-card-${p}`} data-on={active === p}>
      <div className={`channel-logo ${INFO[p].logo}`}>
        <Icon name={INFO[p].icon} size={22} />
      </div>
      <div className="channel-main">
        <div className="channel-name">
          {INFO[p].name}
          {active === p && <span className="chip ok">已启用</span>}
        </div>
        <div className="muted">{INFO[p].desc}</div>
      </div>
      <Switch on={active === p} testid={`office-switch-${p}`} onChange={v => void choose(p, v)} />
    </div>
  );

  return (
    <div className="page" data-testid="office-page">
      <div className="page-head">
        <h1>办公集成</h1>
      </div>
      <div className="muted" style={{ marginBottom: 14 }}>
        飞书、钉钉、自定义三选一，同一时间只能启用一个；打开一个会自动关掉另一个（关掉的平台设置会保留，下次打开恢复）。
      </div>
      {err && <div className="inline-warn">{err}</div>}

      {head("feishu")}
      {active === "feishu" && (
        <>
          <FeishuIntegration state={state} onChanged={onChanged} />
        </>
      )}

      {head("dingtalk")}
      {active === "dingtalk" && (
        <>
          <DingTalkIntegration />
          <DingTalkPlaceholders />
          <DingtalkProjectSection state={state} onChanged={onChanged} />
        </>
      )}

      {head("custom")}
      {active === "custom" && <CustomOffice state={state} onChanged={onChanged} />}

      {active === "feishu" && <ChannelLogs state={state} />}
    </div>
  );
}

/** 自定义平台：名称 + 给模型的使用说明（写进系统提示）。具体怎么连，用 MCP 服务 / 技能 / 命令行工具 */
function CustomOffice({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const saved = ed.cfg?.office?.custom as { name?: string; instructions?: string } | undefined;
  const [name, setName] = useState(saved?.name ?? "");
  const [text, setText] = useState(saved?.instructions ?? "");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);
  useEffect(() => setName(saved?.name ?? ""), [saved?.name]);
  useEffect(() => setText(saved?.instructions ?? ""), [saved?.instructions]);

  const dirty = name !== (saved?.name ?? "") || text !== (saved?.instructions ?? "");
  const save = async () => {
    setErr("");
    const r = await ed.update(c => {
      c.office ??= {};
      c.office.custom = { name: name.trim(), instructions: text.trim() };
    });
    if (!r.ok) setErr(r.error ?? "保存失败");
    setOk(r.ok);
    if (r.ok) setTimeout(() => setOk(false), 2000);
  };

  return (
    <div className="sgroup" style={{ marginBottom: 14 }} data-testid="office-custom">
      <div className="srow">
        <div className="srow-text">
          <div className="srow-title">系统名称</div>
          <div className="srow-desc">比如「公司 OA」「工单系统」，只用来给模型指代</div>
        </div>
        <div className="srow-ctl">
          <input className="input" style={{ width: 280 }} data-testid="office-custom-name" value={name} placeholder="公司 OA" onChange={e => setName(e.target.value)} />
        </div>
      </div>
      <div className="srow" style={{ alignItems: "flex-start" }}>
        <div className="srow-text">
          <div className="srow-title">给模型的使用说明</div>
          <div className="srow-desc">这个系统能做什么、用哪个 MCP 工具或命令去调用、有哪些注意事项。启用后会加进模型的系统提示。真正的连接请在「MCP」里添加服务，或在「技能」里写操作步骤。</div>
        </div>
      </div>
      <div style={{ padding: "0 16px 14px" }}>
        <textarea
          className="input"
          style={{ width: "100%", minHeight: 140, resize: "vertical", fontFamily: "inherit" }}
          data-testid="office-custom-instructions"
          value={text}
          placeholder={"例如：\n请假、报销走公司 OA。用 mcp__oa__* 工具查询和提交；提交前必须先让我确认。"}
          onChange={e => setText(e.target.value)}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
          <button className="btn sm primary" data-testid="office-custom-save" disabled={!dirty} onClick={() => void save()}>
            保存
          </button>
          {ok && <span className="muted">已保存</span>}
          {err && <span className="inline-warn">{err}</span>}
        </div>
      </div>
    </div>
  );
}
