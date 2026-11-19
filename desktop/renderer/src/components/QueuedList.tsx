import type { QueuedMsg } from "../lib/chatStore";
import { Icon } from "./Icon";

/** AI 还在运行时按回车排队的消息：这一轮结束后自动按顺序发出，发出前可以取消 */
export function QueuedList({ items, onCancel }: { items: QueuedMsg[]; onCancel: (i: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="queued-list" data-testid="queued-list">
      {items.map((m, i) => (
        <div className="queued-item" key={i} data-testid="queued-item">
          <span className="queued-tag">排队中</span>
          <span className="queued-text" title={m.text}>
            {m.text}
          </span>
          <button className="icon-btn sm" title="取消这条" data-testid="queued-cancel" onClick={() => onCancel(i)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
