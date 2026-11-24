import { useEffect, useState } from "react";
import type { SkillDTO } from "../../../shared/api";
import { api } from "../api";
import type { ActionItem } from "../lib/actionSteps";
import { Icon } from "./Icon";
import { SearchSelect } from "./SearchSelect";

/** 下拉里「不绑技能、自己写提示词」的取值 */
const OWN = "__prompt__";

/** 新建 / 编辑推进入口：挑一个技能挂到推进面板，再补产出要求和输入框提示（也可以不绑技能、直接写提示词） */
export function ActionDialog({ item, draft, onClose, onSave }: { item?: ActionItem; /** 当新建来开，但先填好这些默认值（内置动作的「编辑」：另存为一个自定义动作） */ draft?: Partial<Omit<ActionItem, "id">>; onClose: () => void; onSave: (v: Omit<ActionItem, "id">) => void }) {
  const src = item ?? draft;
  const [skills, setSkills] = useState<SkillDTO[]>([]);
  const [name, setName] = useState(src?.name ?? "");
  const [pick, setPick] = useState(src ? (src.skill ? src.skill : OWN) : "");
  const [output, setOutput] = useState(src?.output ?? "");
  const [placeholder, setPlaceholder] = useState(src?.placeholder ?? "");
  const [prompt, setPrompt] = useState(src?.prompt ?? "");

  useEffect(() => {
    void api.listSkills().then(setSkills);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const own = pick === OWN;
  const usable = skills.filter(s => s.enabled || s.name === pick);
  // 编辑时绑的技能已经被删 / 关了，也要留在下拉里，别悄悄改掉
  const list = pick && !own && !usable.some(s => s.name === pick) ? [...usable, { name: pick, description: "（技能已不存在）" } as SkillDTO] : usable;
  const ok = name.trim().length > 0 && (own ? prompt.trim().length > 0 : pick.length > 0);

  const save = () => {
    if (!ok) return;
    onSave({
      name: name.trim(),
      prompt: own ? prompt : "",
      skill: own ? undefined : pick,
      output: output.trim() || undefined,
      placeholder: placeholder.trim() || undefined,
      description: src?.description,
      hidden: item?.hidden,
    });
    onClose();
  };

  return (
    <div className="modal-mask" data-testid="action-dialog" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal cx-modal" role="dialog" aria-label={item ? "编辑推进入口" : "新建推进入口"}>
        <div className="cx-head">
          <div>
            <h3>{item ? "编辑推进入口" : "新建推进入口"}</h3>
            <div className="cx-sub">选一个自管 skill 挂到推进面板</div>
          </div>
          <button className="cx-x" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="if-field">
          <label className="cx-label" htmlFor="ad-name">
            动作名
          </label>
          <input id="ad-name" className="cx-input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="如：性能审计" data-testid="action-name" />
        </div>

        <div className="if-field">
          <label className="cx-label" htmlFor="ad-skill">
            主 skill
          </label>
          <SearchSelect
            value={pick}
            onChange={setPick}
            options={[...list.map(s => ({ value: s.name, label: s.name })), { value: OWN, label: "不绑 skill，自己写提示词" }]}
            placeholder="选一个 skill"
            searchPlaceholder="搜索 skill 名字…"
            emptyText="没有匹配的 skill"
            className="cx-input ad-select"
            testid="action-skill"
          />
          {!skills.length && !own && <div className="ad-hint">还没有可用的技能，可以先到「设置 → 技能」新建，或选「不绑 skill，自己写提示词」。</div>}
          {!own && pick && <div className="ad-hint">{skills.find(s => s.name === pick)?.description || "推进时会让 AI 先读取这个技能的完整说明，再按它执行。"}</div>}
        </div>

        {own && (
          <div className="if-field">
            <label className="cx-label" htmlFor="ad-prompt">
              提示词
            </label>
            <textarea id="ad-prompt" className="cx-input ad-area" rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="提示词模板。{{input}} 会替换成推进时填的指令" data-testid="action-prompt" />
          </div>
        )}

        <div className="if-field">
          <label className="cx-label" htmlFor="ad-output">
            产出要求 <span className="adv-opt">（可选）</span>
          </label>
          <textarea id="ad-output" className="cx-input ad-area" rows={3} value={output} onChange={e => setOutput(e.target.value)} placeholder="如：输出回滚记录——回到哪个版本、动了哪些分支、验证结果" data-testid="action-output" />
        </div>

        <div className="if-field">
          <label className="cx-label" htmlFor="ad-ph">
            推进输入框提示 <span className="adv-opt">（可选）</span>
          </label>
          <input id="ad-ph" className="cx-input" value={placeholder} onChange={e => setPlaceholder(e.target.value)} placeholder="推进选中这个 action 时、告诉使用者该填什么" data-testid="action-placeholder" />
        </div>

        <div className="if-foot">
          <button className="if-btn" onClick={onClose}>
            取消
          </button>
          <button className="if-btn primary" onClick={save} disabled={!ok} data-testid="action-create">
            {item ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
