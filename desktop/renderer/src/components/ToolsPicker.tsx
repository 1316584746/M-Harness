import { useEffect, useRef, useState } from "react";
import type { ToolInfo } from "../../../shared/api";
import { api } from "../api";
import { Icon } from "./Icon";

const RISK: Record<string, string> = { read: "只读", write: "写入", exec: "执行", network: "联网" };

/** 对话框里的「工具 N/M」：本对话里可以关掉不想让模型用的工具 */
export function ToolsPicker({ disabled: off, onChange, busy }: { disabled: string[]; onChange: (names: string[]) => void; busy?: boolean }) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => void api.listTools().then(setTools), []);
  useEffect(() => {
    if (!open) return;
    void api.listTools().then(setTools);
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const names = tools.map(t => t.name);
  const offSet = new Set(off.filter(n => names.includes(n)));
  const enabled = tools.length - offSet.size;
  const toggle = (n: string) => onChange(offSet.has(n) ? [...offSet].filter(x => x !== n) : [...offSet, n]);

  return (
    <div className="picker" ref={box}>
      <button type="button" className={`chipbtn ${open ? "on" : ""}`} data-testid="tools-trigger" disabled={busy} onClick={() => setOpen(!open)} title="本对话里模型可以使用的工具">
        <Icon name="plug" size={14} />
        <span>工具</span>
        <span className="count" data-testid="tools-count">
          {enabled}/{tools.length}
        </span>
        <Icon name="down" size={13} />
      </button>
      {open && (
        <div className="menu wide" data-testid="tools-menu">
          <div className="menu-title" style={{ display: "flex", justifyContent: "space-between" }}>
            <span>本对话可用的工具</span>
            <span>
              <a className="link" onClick={() => onChange([])}>
                全部开启
              </a>
              {" · "}
              <a className="link" data-testid="tools-none" onClick={() => onChange(names)}>
                全部关闭
              </a>
            </span>
          </div>
          {tools.map(t => (
            <label key={t.name} className="menu-item check" data-testid={`tool-${t.name}`}>
              <input type="checkbox" checked={!offSet.has(t.name)} onChange={() => toggle(t.name)} />
              <span className="menu-main">
                <span className="menu-name">
                  {t.name}
                  <span className={`tag risk-${t.risk}`}>{RISK[t.risk] ?? t.risk}</span>
                </span>
                <span className="menu-desc">{t.desc}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
