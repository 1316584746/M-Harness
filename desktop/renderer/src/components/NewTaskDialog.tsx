import { useEffect, useState } from "react";
import { prdUrlError } from "../lib/taskStore";
import { Icon } from "./Icon";

/** 手动新建任务：只要一个标题；仓库、上下文、飞书群等进了任务页再补 */
export function NewTaskDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (title: string, prdUrl?: string) => void }) {
  const [title, setTitle] = useState("");
  const [prd, setPrd] = useState("");
  const prdErr = prdUrlError(prd);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const ok = title.trim().length > 0 && !prdErr;
  const go = () => ok && onCreate(title.trim(), prd.trim() || undefined);

  return (
    <div className="modal-mask" data-testid="newtask-dialog" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal cx-modal" role="dialog" aria-label="新建任务">
        <div className="cx-head">
          <h3>新建任务</h3>
          <button className="cx-x" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="if-field">
          <label className="cx-label" htmlFor="nt-title">
            任务标题 <i className="req">*</i>
          </label>
          <input id="nt-title" className="cx-input" autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.nativeEvent.isComposing && go()} placeholder="比如：导出报表加筛选条件" data-testid="newtask-title" />
        </div>
        <div className="if-field">
          <label className="cx-label" htmlFor="nt-prd">
            PRD 链接 <span className="adv-opt">（选填）</span>
          </label>
          <input id="nt-prd" className="cx-input" value={prd} onChange={e => setPrd(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.nativeEvent.isComposing && go()} placeholder="https://xxx.feishu.cn/wiki/…" spellCheck={false} data-testid="newtask-prd" />
          {prdErr ? <span className="if-hint" style={{ color: "var(--bad)" }} data-testid="newtask-prd-err">{prdErr}</span> : <span className="if-hint">不依赖飞书项目 / 钉钉，建好后在任务页里关联仓库、补上下文和需求群；PRD 链接之后也能在「基本信息」里补</span>}
        </div>
        <div className="if-foot">
          <button className="if-btn" onClick={onClose}>
            取消
          </button>
          <button className="if-btn primary" onClick={go} disabled={!ok} data-testid="newtask-ok">
            创建并打开
          </button>
        </div>
      </div>
    </div>
  );
}
