import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

function baseName(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

/** 工作区选择：已登记的仓库 + 任意文件夹 */
export function WorkspacePicker({
  current,
  repos,
  onPick,
  onBrowse,
  disabled,
}: {
  current: string;
  repos: Record<string, { path: string; platform?: string }>;
  onPick: (path: string) => void;
  onBrowse: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const hit = Object.entries(repos).find(([, r]) => r.path.replace(/[\\/]+$/, "").toLowerCase() === current.replace(/[\\/]+$/, "").toLowerCase());

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const names = Object.keys(repos);
  return (
    <div className="picker" ref={box}>
      <button
        type="button"
        className={`chipbtn ${open ? "on" : ""}`}
        data-testid="workspace-trigger"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title={`工作区（工具只能访问这里）\n${current}`}
      >
        <Icon name="folder" size={14} />
        <span>{hit ? hit[0] : baseName(current)}</span>
        <Icon name="down" size={13} />
      </button>
      {open && (
        <div className="menu">
          {names.length > 0 && <div className="menu-title">代码仓库</div>}
          {names.map(n => (
            <button
              key={n}
              type="button"
              data-testid={`workspace-${n}`}
              className={`menu-item ${hit?.[0] === n ? "sel" : ""}`}
              onClick={() => {
                onPick(repos[n].path);
                setOpen(false);
              }}
            >
              <Icon name="folder" size={15} />
              <span className="menu-main">
                <span className="menu-name">{n}</span>
                <span className="menu-desc">{repos[n].path}</span>
              </span>
              {hit?.[0] === n && <Icon name="check" size={15} />}
            </button>
          ))}
          <div className="menu-title">其他</div>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onBrowse();
            }}
          >
            <Icon name="plus" size={15} />
            <span className="menu-main">
              <span className="menu-name">选择其他文件夹…</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
