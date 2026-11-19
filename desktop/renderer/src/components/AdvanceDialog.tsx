import { useEffect, useMemo, useState, type ReactNode } from "react";
import { composeStep, type BuiltinStep } from "../lib/actionSteps";
import type { PromptVars } from "../lib/actionPrompts";
import { Switch } from "../pages/settings/Projects";
import { Icon } from "./Icon";

export interface AdvanceAction {
  id: string;
  name: string;
  prompt: string;
  description?: string;
  skill?: string;
  output?: string;
  placeholder?: string;
}

export interface AdvanceOptions {
  /** true = 不带之前的对话，开一个全新的上下文来做这一步 */
  fresh: boolean;
}

interface Props {
  builtins: BuiltinStep[];
  actions: AdvanceAction[];
  vars?: PromptVars;
  /** 暂时不能选的步骤：id → 原因（卡片置灰并带 ⚠） */
  blocked?: Record<string, string>;
  /** 高级里放的 Agent / 模型选择器 */
  agent?: ReactNode;
  /** 当前对话里已经有内容（没有的话「续用」没有意义，不显示） */
  hasHistory?: boolean;
  onClose: () => void;
  onAdvance: (text: string, opts: AdvanceOptions) => void;
}

/** 推进任务：选下一步（通用 / 你在设置 → ACTIONS 里配的动作），可补一句指令，然后发给 AI */
export function AdvanceDialog({ builtins, actions, vars, blocked = {}, agent, hasHistory = false, onClose, onAdvance }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [cont, setCont] = useState(true);
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [moreOpen, setMoreOpen] = useState(true);
  const all = useMemo<Array<AdvanceAction & { file?: string }>>(() => [...builtins, ...actions], [builtins, actions]);
  const picked = all.find(a => a.id === sel) ?? null;
  const text = composeStep(picked, input, vars);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const toggle = (k: string) => setShut(s => (s.has(k) ? new Set([...s].filter(x => x !== k)) : new Set([...s, k])));
  const go = () => {
    if (!text) return;
    onAdvance(text, { fresh: hasHistory && !cont });
    onClose();
  };
  const card = (a: AdvanceAction, sub: string) => {
    const why = blocked[a.id];
    return (
      <button
        key={a.id}
        className={`adv-card${sel === a.id ? " on" : ""}${why ? " blocked" : ""}`}
        onClick={() => !why && setSel(sel === a.id ? null : a.id)}
        aria-pressed={sel === a.id}
        aria-disabled={!!why}
        title={why || a.description || (a.skill ? `技能：${a.skill}` : a.prompt.slice(0, 120))}
        data-testid="adv-card"
        data-id={a.id}
      >
        <Icon name="spark" size={13} />
        {why && <Icon name="alert" size={14} className="adv-warn" />}
        <span className="adv-name">{a.name}</span>
        <span className="adv-sub">{sub}</span>
      </button>
    );
  };
  const head = (key: string, icon: "bolt" | "spark", label: string, n: number) => (
    <button className="adv-group-head" onClick={() => toggle(key)} aria-expanded={!shut.has(key)}>
      <Icon name={shut.has(key) ? "right" : "down"} size={13} />
      <Icon name={icon} size={14} /> {label} <span className="adv-count">{n}</span>
    </button>
  );

  return (
    <div className="modal-mask" data-testid="advance-dialog" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal cx-modal" role="dialog" aria-label="推进任务">
        <div className="cx-head">
          <h3>推进任务</h3>
          <button className="cx-x" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="adv-label">下一步</div>

        <div className="adv-group">
          {head("builtin", "bolt", "通用", builtins.length)}
          {!shut.has("builtin") && (builtins.length ? <div className="adv-grid">{builtins.map(a => card(a, a.slug))}</div> : <div className="adv-empty">通用步骤都被隐藏了，可以在「设置 → ACTIONS」里打开。</div>)}
        </div>

        <div className="adv-group">
          {head("custom", "spark", "自定义", actions.length)}
          {!shut.has("custom") &&
            (actions.length ? <div className="adv-grid">{actions.map(a => card(a, a.description?.slice(0, 14) || a.skill || "动作"))}</div> : <div className="adv-empty">还没有自定义动作。到「设置 → ACTIONS」点「新增」，挑一个技能挂到推进面板。</div>)}
        </div>

        <div className="adv-label">
          指令 <span className="adv-opt">{picked ? "（选填）" : "（没选下一步时必填）"}</span>
        </div>
        <textarea
          className="cx-input adv-area"
          autoFocus
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && (e.ctrlKey || e.metaKey) && go()}
          placeholder={picked?.placeholder || "需求是什么？要解决什么问题？"}
          data-testid="adv-input"
        />

        {(agent || hasHistory) && (
          <div className="adv-more">
            <button className="adv-more-head" onClick={() => setMoreOpen(v => !v)} aria-expanded={moreOpen} data-testid="adv-more">
              <Icon name={moreOpen ? "down" : "right"} size={13} /> 高级
            </button>
            {moreOpen && (
              <div className="adv-more-body">
                {hasHistory && (
                  <div className="adv-row">
                    <span>
                      续用当前 Agent
                      <small>{cont ? "带着前面的对话继续做" : "不带之前的对话，开一个全新的上下文（任务说明会重新发一遍）"}</small>
                    </span>
                    <Switch on={cont} onChange={setCont} testid="adv-continue" />
                  </div>
                )}
                {agent && <div className="adv-pickers">{agent}</div>}
              </div>
            )}
          </div>
        )}

        <div className="if-foot">
          <button className="if-btn" onClick={onClose}>
            取消
          </button>
          <button className="if-btn primary" onClick={go} disabled={!text} data-testid="adv-go">
            推进 →
          </button>
        </div>
      </div>
    </div>
  );
}
