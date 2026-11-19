import { useEffect, useState, type ReactNode } from "react";
import type { AppState } from "../../../shared/api";
import { api } from "../api";
import type { Theme } from "../App";
import { Icon, type IconName } from "../components/Icon";
import { useConfigEditor } from "../lib/configEdit";
import { ModelsSection } from "./settings/ModelsSection";
import { Actions } from "./settings/Actions";
import { Mcp } from "./settings/Mcp";
import { Office } from "./settings/Office";
import { Connections } from "./settings/Connections";
import { Rules } from "./settings/Rules";
import { Skills } from "./settings/Skills";
import { AutostartRow } from "./settings/AutostartSettings";
import { DataDirRow } from "./settings/DataDirSettings";
import { FontSettings } from "./settings/FontSettings";
import { Repos } from "./settings/Repos";
import { UpdateSettings } from "./settings/UpdateSettings";

type Section = "models" | "general" | "safety" | "repos" | "office" | "connections" | "skills" | "mcp" | "rules" | "actions";
interface SectionDef {
  id: Section;
  label: string;
  icon: IconName;
  /** 图标底色 */
  color: string;
  /** 搜索时也能匹配到的关键词 */
  keywords?: string;
}
const SECTIONS: Array<SectionDef | "divider"> = [
  { id: "models", label: "模型", icon: "brain", color: "#7c5cff", keywords: "api key 密钥 provider agent cursor deepseek openai claude" },
  { id: "general", label: "偏好", icon: "settings", color: "#8a8f98", keywords: "外观 主题 字体 缩放 工作区 开机 自启动 启动 更新 版本 数据目录" },
  { id: "safety", label: "安全与限制", icon: "shield", color: "#1fb36b", keywords: "权限 审批 读取 写入 执行 命令 网络" },
  { id: "repos", label: "代码仓库", icon: "folder", color: "#f59a23", keywords: "git github gitlab gitee token 分支 clone" },
  { id: "office", label: "办公集成", icon: "chat", color: "#2f7bff", keywords: "飞书 钉钉 lark meegle 消息通道 项目管理" },
  { id: "connections", label: "连接", icon: "link", color: "#0ea5e9", keywords: "连接 xxljob xxl-job 调度 数据库 mysql postgresql oracle redis 服务器 ssh 终端 terminal 环境 机器 connection" },
  "divider",
  { id: "skills", label: "SKILLS", icon: "flask", color: "#a855f7", keywords: "skill skills SKILL.md 技能" },
  { id: "mcp", label: "MCP", icon: "plug", color: "#16a6a6", keywords: "mcp server 服务 工具 npx uvx" },
  { id: "rules", label: "RULES", icon: "file", color: "#6366f1", keywords: "rule rules 提示词 约定 AGENTS" },
  { id: "actions", label: "ACTIONS", icon: "play", color: "#ec4899", keywords: "action actions 快捷动作 提示词模板" },
];

function Row({ title, desc, children }: { title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="srow">
      <div className="srow-text">
        <div className="srow-title">{title}</div>
        {desc && <div className="srow-desc">{desc}</div>}
      </div>
      <div className="srow-ctl">{children}</div>
    </div>
  );
}

const POLICY_ROWS: Array<[string, string, string]> = [
  ["read", "读取文件", ""],
  ["write", "写入文件", ""],
  ["exec", "执行命令", "危险命令始终拦截"],
  ["network", "网络请求", "内网地址始终拦截"],
];

export function Settings({
  initial,
  state,
  onChanged,
  theme,
  setTheme,
  onBack,
  onUseRepo,
}: {
  initial?: string;
  state: AppState;
  onChanged: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  onBack: () => void;
  onUseRepo: (path: string) => void;
}) {
  const [sec, setSec] = useState<Section>(() => (SECTIONS.some(s => s !== "divider" && s.id === initial) ? (initial as Section) : "models"));
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const visible = SECTIONS.filter((s): s is SectionDef => s !== "divider" && (!query || (s.label + " " + (s.keywords ?? "")).toLowerCase().includes(query)));
  const current = SECTIONS.find((s): s is SectionDef => s !== "divider" && s.id === sec);
  const ed = useConfigEditor(state, onChanged);

  const changeWorkspace = async () => {
    const p = await api.pickWorkspace();
    if (p) await ed.update(c => void (c.workspace = p));
  };

  const policy: Record<string, string> = ed.cfg?.guard?.policy ?? {};

  return (
    <div className="settings">
      <aside className="settings-nav">
        <label className="settings-search">
          <Icon name="search" size={14} />
          <input
            data-testid="settings-search"
            placeholder="搜索设置"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && visible[0]) {
                setSec(visible[0].id);
                setQ("");
              }
              if (e.key === "Escape") setQ("");
            }}
          />
        </label>
        {query
          ? visible.map(s => (
              <button key={s.id} data-testid={`settings-${s.id}`} className={`snav ${sec === s.id ? "active" : ""}`} onClick={() => (setSec(s.id), setQ(""))}>
                <span className="snav-ico" style={{ background: s.color }}>
                  <Icon name={s.icon} size={13} />
                </span>
                {s.label}
              </button>
            ))
          : SECTIONS.map((s, i) =>
              s === "divider" ? (
                <div key={i} className="settings-divider" />
              ) : (
                <button key={s.id} data-testid={`settings-${s.id}`} className={`snav ${sec === s.id ? "active" : ""}`} onClick={() => setSec(s.id)}>
                  <span className="snav-ico" style={{ background: s.color }}>
                    <Icon name={s.icon} size={13} />
                  </span>
                  {s.label}
                </button>
              ),
            )}
        {query && !visible.length && <div className="settings-nomatch">没有匹配的设置</div>}
      </aside>

      <div className="settings-body">
        <div className="settings-top">
          <span className="settings-top-title" data-testid="settings-title">
            {current?.label}
          </span>
          <button className="settings-close" data-testid="settings-back" title="关闭设置" onClick={onBack}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className={`settings-inner${sec === "connections" ? " wide" : ""}`}>

          {state.configError && (
            <div className="inline-warn" data-testid="config-error">
              配置文件有误，已回退到上一次可用的配置：{state.configError}
            </div>
          )}
          <div className="panel">
            {sec === "models" && <ModelsSection state={state} onChanged={onChanged} />}

            {sec === "general" && (
              <>
                <div className="card-section">
                  <h2>常规</h2>
                  <div className="sgroup">
                    <Row title="外观">
                      <div className="seg">
                        <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")}>
                          <Icon name="moon" size={14} /> 深色
                        </button>
                        <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")}>
                          <Icon name="sun" size={14} /> 浅色
                        </button>
                      </div>
                    </Row>
                    <FontSettings />
                    <Row title="工作区" desc="工具只能读写此目录">
                      <code className="path">{state.workspace}</code>
                      <button className="btn sm" onClick={changeWorkspace}>
                        更改
                      </button>
                    </Row>
                    <AutostartRow />
                  </div>
                </div>
                <div className="card-section">
                  <h3>数据位置</h3>
                  <div className="sgroup">
                    <DataDirRow />
                    <Row title="Trace 目录">
                      <code className="path">{state.traceDir}</code>
                    </Row>
                  </div>
                </div>
                <UpdateSettings state={state} onChanged={onChanged} />
              </>
            )}

            {sec === "safety" && (
              <>
                <div className="card-section">
                  <h2>工具权限</h2>
                  <div className="sgroup">
                    {POLICY_ROWS.map(([k, title, desc]) => (
                      <Row key={k} title={title} desc={desc}>
                        <select
                          className="input"
                          data-testid={`policy-${k}`}
                          value={policy[k] ?? (k === "read" ? "allow" : "ask")}
                          onChange={e => {
                            const v = e.target.value; // 先取值：保存是异步的，等会儿再读 e.target 会拿到被界面还原的旧值
                            void ed.update(c => void ((c.guard ??= {}).policy = { ...(c.guard.policy ?? {}), [k]: v }));
                          }}
                        >
                          <option value="allow">直接允许</option>
                          <option value="ask">每次询问</option>
                          <option value="deny">一律拒绝</option>
                        </select>
                      </Row>
                    ))}
                  </div>
                </div>
              </>
            )}

            {sec === "repos" && <Repos state={state} onChanged={onChanged} onUse={onUseRepo} />}
            {sec === "office" && <Office state={state} onChanged={onChanged} />}
            {sec === "connections" && <Connections />}
            {sec === "skills" && <Skills state={state} onChanged={onChanged} />}
            {sec === "mcp" && <Mcp state={state} onChanged={onChanged} />}
            {sec === "rules" && <Rules state={state} onChanged={onChanged} />}
            {sec === "actions" && <Actions state={state} onChanged={onChanged} />}
          </div>
        </div>
      </div>
    </div>
  );
}
