import { useEffect, useState } from "react";
import { docKind, taskUrl, type Task, type TaskDoc } from "../lib/taskStore";
import { Icon, type IconName } from "./Icon";
import { SessionContext } from "./SessionContext";

const KIND: Record<ReturnType<typeof docKind>, { label: string; icon: IconName }> = {
  url: { label: "URL", icon: "link" },
  path: { label: "路径", icon: "folder" },
  text: { label: "文本", icon: "file" },
};

const SOURCE_NAME: Record<Task["source"], string> = { feishu: "飞书 story", dingtalk: "钉钉待办", manual: "手动新建的任务" };

/** 任务上下文：一条一条加文档（链接 / 本机路径 / 文字），发给 AI 前一起带上 */
export function ContextDialog({ task, turns, onClose, onChange }: { task: Task; turns: { runId?: string; traceFile?: string }[]; onClose: () => void; onChange: (patch: Partial<Task>) => void }) {
  // 点「上下文」先看这个任务会话的上下文（「上下文洞察」插件里的信息）；发给 AI 的文档清单在另一个标签页
  const [tab, setTab] = useState<"session" | "docs">("session");
  const docs = task.docs ?? [];
  const url = taskUrl(task);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const add = () => {
    const c = content.trim();
    if (!c) return;
    const t = title.trim() || c.replace(/\s+/g, " ").slice(0, 24);
    onChange({ docs: [...docs, { id: `d${Date.now().toString(36)}`, title: t, content: c, added: Date.now() }] });
    setTitle("");
    setContent("");
  };
  const del = (id: string) => onChange({ docs: docs.filter(d => d.id !== id) });

  const Row = ({ d }: { d: TaskDoc }) => {
    const k = KIND[docKind(d.content)];
    const isOpen = open === d.id;
    return (
      <div className={`cx-item${isOpen ? " open" : ""}`} data-testid="ctx-doc">
        <button className="cx-item-head" onClick={() => setOpen(isOpen ? null : d.id)} aria-expanded={isOpen}>
          <Icon name={k.icon} size={14} />
          <b>{d.title}</b>
          <span className="cx-preview">{d.content.replace(/\s+/g, " ")}</span>
          <span className="cx-tag">{k.label}</span>
        </button>
        <button className="cx-del" onClick={() => del(d.id)} title="删除" aria-label="删除">
          <Icon name="trash" size={14} />
        </button>
        {isOpen && (k.label === "URL" ? <a className="cx-full cx-linkfull" href={d.content.trim()} target="_blank" rel="noreferrer">{d.content.trim()}</a> : <pre className="cx-full">{d.content}</pre>)}
      </div>
    );
  };

  return (
    <div className="modal-mask" data-testid="ctx-dialog" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${tab === "session" ? "sc-modal" : "cx-modal"}`} role="dialog" aria-label="任务上下文">
        <div className="cx-head">
          <h3 className="sc-title" title={task.title}>{task.title}</h3>
          <button className="cx-x" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="cx-tabs" role="tablist">
          <button className={`cx-tab ${tab === "session" ? "on" : ""}`} role="tab" aria-selected={tab === "session"} data-testid="ctx-tab-session" onClick={() => setTab("session")}>
            <Icon name="list" size={13} /> 会话上下文
          </button>
          <button className={`cx-tab ${tab === "docs" ? "on" : ""}`} role="tab" aria-selected={tab === "docs"} data-testid="ctx-tab-docs" onClick={() => setTab("docs")}>
            <Icon name="file" size={13} /> 任务文档 <span className="num">{docs.length + (task.context.trim() ? 1 : 0)}</span>
          </button>
        </div>
        {tab === "session" && <SessionContext convId={`task-${task.id}`} turns={turns} />}
        {tab === "docs" && <p className="cx-sub">每次发给 AI 前都会带上这些清单；链接和本机文件由 AI 按需读取（点条目看全文）</p>}

        {tab === "docs" && <div className="cx-list">
          {url && (
            <div className="cx-item static">
              <a className="cx-item-head cx-open" href={url} target="_blank" rel="noreferrer" title={`在浏览器中打开：${url}`} data-testid="ctx-url">
                <Icon name="link" size={14} />
                <b>{SOURCE_NAME[task.source] ?? "需求"}</b>
                <span className="cx-preview">{url}</span>
                <span className="cx-tag">URL</span>
                <Icon name="external" size={13} />
              </a>
            </div>
          )}
          {task.context.trim() && (
            <div className="cx-item" data-testid="ctx-legacy">
              <button className="cx-item-head" onClick={() => setOpen(open === "legacy" ? null : "legacy")} aria-expanded={open === "legacy"}>
                <Icon name="file" size={14} />
                <b>补充说明</b>
                <span className="cx-preview">{task.context.replace(/\s+/g, " ")}</span>
                <span className="cx-tag">文本</span>
              </button>
              <button className="cx-del" onClick={() => onChange({ context: "" })} title="删除" aria-label="删除">
                <Icon name="trash" size={14} />
              </button>
              {open === "legacy" && <pre className="cx-full">{task.context}</pre>}
            </div>
          )}
          {docs.map(d => (
            <Row key={d.id} d={d} />
          ))}
        </div>}

        {tab === "docs" && <div className="cx-form">
          <div className="cx-form-title">
            <Icon name="plus" size={14} /> 添加新文档
          </div>
          <label className="cx-label" htmlFor="cx-title">
            标题
          </label>
          <input id="cx-title" className="cx-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="如：后端技术方案 / 设计稿 / 开发补充" data-testid="ctx-title" />
          <label className="cx-label" htmlFor="cx-content">
            内容
          </label>
          <textarea
            id="cx-content"
            className="cx-input cx-area"
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={e => e.key === "Enter" && (e.ctrlKey || e.metaKey) && add()}
            placeholder="贴 URL / 给绝对路径 / 直接写文本"
            data-testid="ctx-content"
          />
          <div className="cx-form-foot">
            <span className="cx-hint">Ctrl+Enter 添加</span>
            <button className="cx-add" onClick={add} disabled={!content.trim()} data-testid="ctx-add">
              添加
            </button>
          </div>
        </div>}
      </div>
    </div>
  );
}
