import { useState } from "react";
import type { ApprovalRequest } from "../../../shared/api";
import { api } from "../api";
import { Icon, type IconName } from "./Icon";

const RISK: Record<string, { label: string; icon: IconName }> = {
  read: { label: "读取", icon: "file" },
  write: { label: "写入文件", icon: "edit" },
  exec: { label: "执行命令", icon: "terminal" },
  network: { label: "网络请求", icon: "globe" },
};

export function ApprovalModal({ req, queued, onDone }: { req: ApprovalRequest; queued: number; onDone: () => void }) {
  const [remember, setRemember] = useState(false);
  const risk = RISK[req.risk] ?? { label: req.risk, icon: "shield" as IconName };

  const answer = async (ok: boolean) => {
    await api.respondApproval(req.id, ok, ok && remember);
    onDone();
  };

  const args = (req.args ?? {}) as Record<string, unknown>;
  let title = "";
  let body = "";
  if (req.tool === "run_command") {
    title = "将要执行命令";
    body = String(args.command ?? "");
  } else if (req.tool === "write_file") {
    title = `将要写入 ${String(args.path ?? "")}`;
    body = String(args.content ?? "").slice(0, 4000);
  } else if (req.tool === "http_request") {
    title = `将要请求 ${String(args.method ?? "GET")} ${String(args.url ?? "")}`;
    body = args.body ? String(args.body).slice(0, 4000) : "";
  } else {
    title = req.tool;
    body = JSON.stringify(args, null, 2);
  }

  return (
    <div className="modal-mask" data-testid="approval-modal" role="dialog" aria-modal>
      <div className="modal">
        <div className="modal-head">
          <span className={`modal-icon ${req.risk}`}>
            <Icon name={risk.icon} size={20} />
          </span>
          <div>
            <h3>需要你确认</h3>
            <div className="muted">
              {risk.label} · {req.tool}
              {queued > 0 && <span className="chip warn" style={{ marginLeft: 8 }}>还有 {queued} 个待处理</span>}
            </div>
          </div>
        </div>
        <div className="modal-title">{title}</div>
        {body && <pre className="approval-body">{body}</pre>}
        <label className="check">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          <span>
            本次打开期间始终允许 <b>{req.tool}</b>
            <span className="muted">（危险命令规则仍会拦截）</span>
          </span>
        </label>
        <div className="modal-actions">
          <button className="btn" data-testid="approval-deny" onClick={() => answer(false)}>
            拒绝
          </button>
          <button className="btn primary" data-testid="approval-allow" onClick={() => answer(true)} autoFocus>
            {remember ? "允许并记住" : "允许一次"}
          </button>
        </div>
      </div>
    </div>
  );
}
