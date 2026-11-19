import { useEffect, useState } from "react";
import type { RepoInfo } from "../../../shared/api";
import { taskUrl, type Task } from "../lib/taskStore";
import { Icon } from "./Icon";

export interface InfoDialogProps {
  task: Task;
  repos: RepoInfo[];
  /** 来源名（飞书项目 / 钉钉待办） */
  sourceText: string;
  /** 排期的文字 */
  schedule: string;
  onClose: () => void;
  onSave: (patch: Partial<Task>) => void;
  /** 改关联仓库（会自动切分支并拉最新代码） */
  onRepos: (names: string[]) => void;
}

/** 任务基本信息：改标题、补 REQ-ID、换目标仓库；来源链接创建后不可改 */
export function InfoDialog({ task, repos, sourceText, schedule, onClose, onSave, onRepos }: InfoDialogProps) {
  const url = taskUrl(task);
  const [title, setTitle] = useState(task.title);
  const [reqId, setReqId] = useState(task.reqId ?? "");
  const current = task.repos[0] ?? "";
  const [repo, setRepo] = useState(current);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const ok = title.trim().length > 0;
  const save = () => {
    if (!ok) return;
    onSave({ title: title.trim(), reqId: reqId.trim() || undefined });
    // 选了另一个仓库：它排到第一位（其余已关联的保留）
    if (repo !== current) onRepos(repo ? [repo, ...task.repos.filter(n => n !== repo)] : task.repos.filter(n => n !== current));
    onClose();
  };
  const meta: Array<[string, string]> = [
    ["来源", sourceText],
    ["工作项 ID", task.itemId],
    ...(task.node ? ([["节点", task.node]] as Array<[string, string]>) : []),
    ["排期", schedule],
    ...(task.sub ? ([["备注", task.sub]] as Array<[string, string]>) : []),
    ["创建于", new Date(task.created).toLocaleString("zh-CN")],
  ];
  const known = repos.some(r => r.name === repo);

  return (
    <div className="modal-mask" data-testid="info-dialog" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal cx-modal" role="dialog" aria-label="任务基本信息">
        <div className="cx-head">
          <h3>任务基本信息</h3>
          <button className="cx-x" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="if-field">
          <label className="cx-label" htmlFor="if-title">
            任务标题 <i className="req">*</i>
          </label>
          <input id="if-title" className="cx-input" autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === "Enter" && save()} data-testid="info-title" />
        </div>

        {url && (
          <div className="if-field">
            <label className="cx-label" htmlFor="if-url">
              {sourceText}链接
            </label>
            <input id="if-url" className="cx-input" value={url} readOnly disabled data-testid="info-url" />
            <span className="if-hint">需求身份创建后不可改，需要请新建任务</span>
          </div>
        )}

        <div className="if-field">
          <label className="cx-label" htmlFor="if-req">
            REQ-ID
          </label>
          <input id="if-req" className="cx-input" value={reqId} onChange={e => setReqId(e.target.value)} placeholder="暂无 REQ-ID，可后补" data-testid="info-reqid" />
        </div>

        <div className="if-field">
          <label className="cx-label" htmlFor="if-repo">
            目标仓库
          </label>
          <div className="if-select">
            <select id="if-repo" className="cx-input" value={repo} onChange={e => setRepo(e.target.value)} data-testid="info-repo">
              <option value="">未关联</option>
              {!known && repo && <option value={repo}>{repo}（已不在配置里）</option>}
              {repos.map(r => (
                <option key={r.name} value={r.name}>
                  {r.name}　{r.path}
                </option>
              ))}
            </select>
            <Icon name="down" size={14} />
          </div>
          {task.repos.length > 1 && <span className="if-hint">还关联了 {task.repos.length - 1} 个其他仓库，可在「关联仓库」里调整</span>}
        </div>

        <dl className="if-meta">
          {meta.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={k === "工作项 ID" ? "mono" : ""}>{v}</dd>
            </div>
          ))}
        </dl>

        <div className="if-foot">
          <button className="if-btn" onClick={onClose}>
            取消
          </button>
          <button className="if-btn primary" onClick={save} disabled={!ok} data-testid="info-save">
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
