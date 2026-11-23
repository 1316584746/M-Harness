import { useCallback, useEffect, useRef, useState } from "react";
import type { BranchInfoDTO } from "../../../shared/api";
import { api } from "../api";
import { Icon } from "./Icon";

/**
 * 聊天输入框里的分支选择：工作区是 Git 仓库时显示当前分支，点开可以切到别的分支（git switch）。
 * 不是仓库就不显示；切换失败（比如未提交的改动和目标分支冲突）把 git 的原因原样显示出来，不会强切。
 * refreshKey 变化时重新读（一轮对话结束后，AI 可能自己切过分支）。
 */
export function BranchPicker({ dir, disabled, refreshKey }: { dir: string; disabled?: boolean; refreshKey?: unknown }) {
  const [info, setInfo] = useState<BranchInfoDTO | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await api.branchInfo(dir).catch(() => null);
    setInfo(r);
  }, [dir]);

  useEffect(() => {
    setInfo(null);
    setOpen(false);
    setErr("");
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!open) return;
    void load(); // 打开时再读一遍，命令行里新建 / 切换的分支马上能看到
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open, load]);

  if (!info?.isRepo) return null;

  const pick = async (b: string) => {
    if (b === info.current) return setOpen(false);
    setBusy(true);
    setErr("");
    const r = await api.switchBranch(dir, b);
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "切换失败");
    setOpen(false);
    setQ("");
    await load();
  };

  const k = q.trim().toLowerCase();
  const match = (b: string) => !k || b.toLowerCase().includes(k);
  const local = info.local.filter(match);
  const remote = info.remote.filter(match);

  return (
    <div className="picker" ref={box}>
      <button
        type="button"
        className={`chipbtn ${open ? "on" : ""}`}
        data-testid="branch-trigger"
        disabled={disabled || busy}
        onClick={() => (setOpen(!open), setErr(""))}
        title={`当前分支${info.dirty ? "（有未提交的改动）" : ""}；点开切换分支`}
      >
        <Icon name="branch" size={14} />
        <span>{info.current ?? "游离 HEAD"}</span>
        {info.dirty && <span className="branch-dirty" title="有未提交的改动" />}
        <Icon name="down" size={13} />
      </button>
      {open && (
        <div className="menu branch-menu" data-testid="branch-menu">
          <input className="input branch-search" autoFocus placeholder="搜索分支…" value={q} onChange={e => setQ(e.target.value)} data-testid="branch-search" />
          {err && (
            <div className="inline-warn branch-err" data-testid="branch-error">
              {err}
            </div>
          )}
          <div className="branch-list">
            {local.length > 0 && <div className="menu-title">本地分支</div>}
            {local.map(b => (
              <button key={b} type="button" className={`menu-item ${b === info.current ? "sel" : ""}`} data-testid={`branch-${b}`} disabled={busy} onClick={() => void pick(b)}>
                <Icon name="branch" size={15} />
                <span className="menu-main">
                  <span className="menu-name">{b}</span>
                </span>
                {b === info.current && <Icon name="check" size={15} />}
              </button>
            ))}
            {remote.length > 0 && <div className="menu-title">远端分支（切换时自动建本地分支）</div>}
            {remote.map(b => (
              <button key={`r:${b}`} type="button" className="menu-item" data-testid={`branch-remote-${b}`} disabled={busy} onClick={() => void pick(b)}>
                <Icon name="branch" size={15} />
                <span className="menu-main">
                  <span className="menu-name">{b}</span>
                </span>
              </button>
            ))}
            {local.length + remote.length === 0 && <div className="menu-title">没有匹配的分支</div>}
          </div>
        </div>
      )}
    </div>
  );
}
