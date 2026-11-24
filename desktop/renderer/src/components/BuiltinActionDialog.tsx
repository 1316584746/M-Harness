import { useEffect, useState } from "react";
import { Icon } from "./Icon";

/** 编辑内置动作的提示词：直接改这一条（改的是动作自己的那份，共享规范不动）；可以恢复成软件自带的，也可以另存为自定义动作 */
export function BuiltinActionDialog({
  name,
  file,
  body,
  defaultBody,
  edited,
  onClose,
  onSave,
  onReset,
  onSaveAs,
}: {
  name: string;
  file?: string;
  /** 现在生效的内容 */
  body: string;
  /** 软件自带的内容 */
  defaultBody: string;
  edited: boolean;
  onClose: () => void;
  onSave: (body: string) => void;
  onReset: () => void;
  onSaveAs: (body: string) => void;
}) {
  const [text, setText] = useState(body);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const ok = text.trim().length > 0;
  const same = text.trim() === body.trim();

  return (
    <div className="modal-mask" data-testid="builtin-dialog" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal cx-modal bd-modal" role="dialog" aria-label={`编辑内置动作：${name}`}>
        <div className="cx-head">
          <div>
            <h3>编辑内置动作：{name}</h3>
            <div className="cx-sub">
              直接修改这一条的提示词，保存后马上生效{file ? `（来自 prompts/${file}）` : ""}。共享规范（prompts/_shared.md）所有动作共用，不在这里改。
            </div>
          </div>
          <button className="cx-x" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="if-field">
          <label className="cx-label" htmlFor="bd-body">
            提示词 {edited && <span className="adv-opt">（已修改）</span>}
          </label>
          <textarea id="bd-body" className="cx-input ad-area bd-area" rows={22} autoFocus spellCheck={false} value={text} onChange={e => setText(e.target.value)} data-testid="builtin-body" />
          <span className="if-hint">
            可用占位符：{"{{taskTitle}} {{taskId}} {{repoPath}} {{input}}"}，发送时替换；{"{{input}}"} 是推进时你填的指令。
          </span>
        </div>

        <div className="if-foot">
          <button className="if-btn" onClick={() => onSaveAs(text)} title="按现在的内容另存为一个自定义动作，这条内置的保持不变" data-testid="builtin-saveas">
            另存为自定义
          </button>
          <span className="spacer" />
          {(edited || text.trim() !== defaultBody.trim()) && (
            <button className="if-btn" onClick={() => (edited ? onReset() : setText(defaultBody))} title="恢复成软件自带的提示词" data-testid="builtin-reset">
              恢复默认
            </button>
          )}
          <button className="if-btn" onClick={onClose}>
            取消
          </button>
          <button className="if-btn primary" disabled={!ok || same} onClick={() => onSave(text.trim())} data-testid="builtin-save">
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
