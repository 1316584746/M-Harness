import { useEffect, useMemo, useRef, useState } from "react";

const MAX_H = 240;

/**
 * 分支名输入框：可以直接打字，也可以从下面的候选里选。
 * 候选按输入的内容筛选；多的时候下拉框里可以滚动（滚轮 / 滑动 / 上下键都行）。
 * 输入框本身的 data-testid 就是 testid；每个候选是 `bi-opt`，值在 data-value 上。
 */
export function BranchInput({ value, onChange, options, placeholder, testid, className = "input mono" }: { value: string; onChange: (v: string) => void; options: string[]; placeholder?: string; testid?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // 输入的正好是某个分支时，列出全部，方便换成别的；否则按输入筛选
  const items = useMemo(() => {
    const k = value.trim().toLowerCase();
    if (!k || options.includes(value.trim())) return options;
    return options.filter(b => b.toLowerCase().includes(k));
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".hi")?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  const pick = (b: string) => {
    onChange(b);
    setOpen(false);
    setHi(-1);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      setOpen(true);
      setHi(h => (e.key === "ArrowDown" ? (h + 1) % items.length : (h <= 0 ? items.length : h) - 1));
    } else if (e.key === "Enter" && open && hi >= 0 && items[hi] && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(items[hi]);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="bi" ref={box}>
      <input
        className={className}
        data-testid={testid}
        data-branch-input=""
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={e => (onChange(e.target.value), setOpen(true), setHi(-1))}
        onKeyDown={onKey}
      />
      {open && items.length > 0 && (
        <div className="bi-pop" ref={list} role="listbox" style={{ maxHeight: MAX_H }} data-testid="bi-pop">
          {items.map((b, i) => (
            <div key={b} role="option" aria-selected={b === value} data-testid="bi-opt" data-value={b} className={`bi-item${i === hi ? " hi" : ""}${b === value ? " sel" : ""}`} title={b} onMouseDown={e => e.preventDefault()} onMouseMove={() => i !== hi && setHi(i)} onClick={e => (e.preventDefault(), pick(b))}>
              {b}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
