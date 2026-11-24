import { useEffect, useRef, useState } from "react";
import type { ProviderInfo } from "../../../shared/api";
import { Icon } from "./Icon";
import { matchOption } from "./SearchSelect";

export function ProviderPicker({
  providers,
  value,
  onChange,
  disabled,
}: {
  providers: ProviderInfo[];
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const cur = providers.find(p => p.name === value);
  const [q, setQ] = useState("");
  const shown = providers.filter(p => matchOption({ value: p.name, label: p.name, hint: p.desc }, q));

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

  return (
    <div className="picker" ref={box}>
      <button
        type="button"
        className={`chipbtn ${open ? "on" : ""}`}
        data-testid="provider-trigger"
        disabled={disabled}
        onClick={() => (setQ(""), setOpen(!open))}
        title={cur?.desc ? `${value} · ${cur.desc}` : value}
      >
        <Icon name={cur?.kind === "agent" ? "bot" : "spark"} size={14} />
        <span className="pk-label">{value}</span>
        <Icon name="down" size={13} />
      </button>
      {open && (
        <div className="menu" role="listbox">
          <div className="menu-title">选择模型 / Agent</div>
          <input className="input menu-search" data-testid="provider-search" placeholder="搜索" value={q} onChange={e => setQ(e.target.value)} autoFocus />
          {shown.length === 0 && <div className="menu-empty">没有匹配的</div>}
          {shown.map(p => (
            <button
              key={p.name}
              type="button"
              role="option"
              aria-selected={p.name === value}
              data-testid={`provider-${p.name}`}
              className={`menu-item ${p.name === value ? "sel" : ""}`}
              disabled={!!p.problem}
              onClick={() => {
                onChange(p.name);
                setOpen(false);
              }}
            >
              <span className={`dot ${p.problem ? "bad" : "ok"}`} />
              <span className="menu-main">
                <span className="menu-name">
                  {p.name}
                  {p.kind === "agent" && <span className="tag">外部 Agent</span>}
                </span>
                <span className="menu-desc">{p.problem ?? p.desc}</span>
              </span>
              {p.name === value && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
