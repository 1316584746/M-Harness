import { useEffect, useState } from "react";
import type { WorkChatDTO } from "../../../shared/api";
import type { Task } from "../lib/taskStore";
import { Icon } from "./Icon";

type Reply = NonNullable<Task["groupReply"]>;
type Mode = "auto" | "bind";

const REPLY: Array<{ id: Reply; label: string }> = [
  { id: "global", label: "跟随全局" },
  { id: "stream", label: "流式" },
  { id: "whole", label: "整条发送" },
];

export interface GroupDialogProps {
  task: Task;
  grp: WorkChatDTO | null;
  busy: boolean;
  onClose: () => void;
  /** 重新读取当前关联 */
  onReload: () => void;
  /** 关联到指定的群（群 ID 或群链接）；返回错误信息，成功返回 undefined */
  onBind: (ref: string) => Promise<string | undefined>;
  /** 按工作项建一个群并关联到本任务 */
  onCreate: () => Promise<string | undefined>;
  /** 取消手动关联，回到飞书项目里的默认群 */
  onUnbind: () => void;
  onReply: (r: Reply) => void;
}

/** 需求群：看当前关联的群、设置群里 AI 的回复方式、自动创建或绑定已有群 */
export function GroupDialog({ task, grp, busy, onClose, onReload, onBind, onCreate, onUnbind, onReply }: GroupDialogProps) {
  const linked = !!grp?.ok && !!grp.groupId;
  const [mode, setMode] = useState<Mode | null>(null);
  const [ref, setRef] = useState("");
  const [err, setErr] = useState("");
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const reply = task.groupReply ?? "global";
  // 还没有关联群时，默认停在「自动创建」；已有群时默认不选，主按钮是置灰的「绑定需求群」
  const active: Mode | null = mode ?? (!linked && !busy ? "auto" : null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !working && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose, working]);

  const submit = async () => {
    if (!active) return grp?.link && window.open(grp.link, "_blank");
    setErr("");
    setWorking(true);
    const e = await (active === "auto" ? onCreate() : onBind(ref)).catch((x: unknown) => (x instanceof Error ? x.message : String(x)));
    setWorking(false);
    if (e) setErr(e);
    else {
      setMode(null);
      setRef("");
    }
  };

  const primary = active === "auto" ? (working ? "正在创建…" : "自动创建并关联") : active === "bind" ? (working ? "正在关联…" : "绑定并关联") : "绑定需求群";
  // 已关联群、又没选要换成什么时，主按钮置灰（不可操作）；没关联群时默认是「自动创建并关联」，可以直接点
  const disabled = working || (active === "bind" && !ref.trim()) || !active;
  const manual = !!task.groupId;

  return (
    <div className="modal-mask" data-testid="group-dialog" onMouseDown={e => e.target === e.currentTarget && !working && onClose()}>
      <div className="modal cx-modal" role="dialog" aria-label="需求群">
        <div className="cx-head">
          <h3>需求群</h3>
          <button className="cx-x" onClick={onClose} aria-label="关闭" disabled={working}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <p className="cx-sub">本任务关联的飞书需求群。换关联后，旧群不再对应本任务。</p>

        <div className="grp-card" data-testid="group-card">
          {busy && !grp ? (
            <span className="muted">正在读取当前关联…</span>
          ) : grp && !grp.ok ? (
            <span className="bad-text">{grp.error ?? "读取失败"}</span>
          ) : grp?.groupId ? (
            <>
              <div className="grp-row">
                <b className="grp-name" title={grp.name}>
                  {grp.name ?? <span className="muted">群名未读到（lark-cli 登录后可显示）</span>}
                </b>
                <span className={`grp-chip${grp.status === "dissolved" ? " bad" : ""}`}>{grp.status === "dissolved" ? "已解散" : grp.status === "normal" || !grp.status ? "正常" : grp.status}</span>
              </div>
              <div className="grp-row">
                <code className="grp-id">{grp.groupId}</code>
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(grp.groupId!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  <Icon name="copy" size={12} /> {copied ? "已复制" : "复制群 ID"}
                </button>
              </div>
              <div className="grp-src">
                {manual ? "已手动关联到本任务" : "项目群默认（未手动关联）"}
                {manual && (
                  <button className="grp-link" onClick={onUnbind}>
                    恢复默认
                  </button>
                )}
              </div>
            </>
          ) : (
            <div>
              <span className="muted">
                这个需求在飞书项目里没有关联群{grp?.how ? `（拉群方式：${grp.how}）` : ""}。可以在下面自动创建一个，或绑定已有的群。
              </span>
              {grp?.candidates && !grp.candidates.length && (
                <div className="grp-note" data-testid="group-no-candidates">
                  按需求名没在你所在的群里搜到名字相近的群（也可能 lark-cli 还没登录）。已有的群请选「绑定已有群」，粘贴群链接或群 ID。
                </div>
              )}
              {!!grp?.candidates?.length && (
                <div className="grp-cands" data-testid="group-candidates">
                  <div className="grp-label">按需求名在你所在的群里找到：</div>
                  {grp.candidates.map(c => (
                    <div className="grp-row" key={c.id}>
                      <b className="grp-name" title={c.id}>
                        {c.name}
                      </b>
                      <button
                        className="btn sm"
                        disabled={working}
                        onClick={async () => {
                          setErr("");
                          setWorking(true);
                          const e = await onBind(c.id).catch((x: unknown) => (x instanceof Error ? x.message : String(x)));
                          setWorking(false);
                          if (e) setErr(e);
                        }}
                      >
                        关联这个群
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {linked && (
          <>
            <div className="grp-label">群里 AI 的回复方式</div>
            <div className="grp-reply" role="radiogroup">
              {REPLY.map(r => (
                <button key={r.id} role="radio" aria-checked={reply === r.id} className={reply === r.id ? "on" : ""} onClick={() => onReply(r.id)}>
                  {r.label}
                </button>
              ))}
            </div>
            <p className="grp-note">只管这个任务的群，已保存在本任务里；「跟随全局」按设置页的全局开关。群里 AI 自动回复接入后会按这里发送。</p>
          </>
        )}

        <div className="grp-modes">
          <button className={`grp-mode${active === "auto" ? " on" : ""}`} onClick={() => (setMode(active === "auto" && linked ? null : "auto"), setErr(""))} data-testid="group-mode-auto">
            <b>自动创建</b>
            <span>按工作项名新建一个飞书群并关联到本任务，你是群主，其他人在飞书里拉入</span>
          </button>
          <button className={`grp-mode${active === "bind" ? " on" : ""}`} onClick={() => (setMode(active === "bind" ? null : "bind"), setErr(""))} data-testid="group-mode-bind">
            <b>绑定已有群</b>
            <span>把本任务指向你指定的群</span>
          </button>
        </div>

        {active === "bind" && (
          <input className="grp-input" autoFocus placeholder="粘贴群 ID（oc_…）或群链接" value={ref} onChange={e => setRef(e.target.value)} onKeyDown={e => e.key === "Enter" && !disabled && void submit()} data-testid="group-bind-input" />
        )}
        {active === "bind" && !ref.trim() && <p className="grp-note">先粘贴群 ID 或群链接，「绑定并关联」才能点。群链接：飞书群 → 设置 → 群链接 / 复制群 ID。</p>}
        {err && <div className="grp-err" data-testid="group-error">{err}</div>}

        <p className="grp-note">建议只绑定都是可信同事的内部群。</p>

        <div className="grp-foot">
          <button className="btn sm ghost" onClick={onReload} disabled={busy || working} title="重新读取当前关联">
            <Icon name="refresh" size={12} /> {busy ? "读取中…" : "刷新"}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={working}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={disabled} data-testid="group-submit">
            {primary}
          </button>
        </div>
      </div>
    </div>
  );
}
