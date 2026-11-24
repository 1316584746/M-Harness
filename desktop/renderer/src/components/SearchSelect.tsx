import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";

export interface SelOption {
  value: string;
  label: string;
  /** 跟在名字后面的小字，如模型 id；也参与筛选 */
  hint?: string;
  /** 分组标题；同组的选项要挨在一起 */
  group?: string;
  disabled?: boolean;
}

/** 多个关键字用空格隔开，每个都要出现在名字 / id / 分组里（不分大小写） */
export function matchOption(o: SelOption, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${o.label} ${o.value} ${o.hint ?? ""} ${o.group ?? ""}`.toLowerCase();
  return words.every(w => hay.includes(w));
}

const MAX_H = 300;

/**
 * 可筛选的下拉框：点开后有搜索框，边打字边过滤，上下键选、回车确定、Esc 关。
 * allowCustom：列表里没有的值也能直接用（搜索框里输入什么就用什么）。
 * 触发按钮的 data-testid 就是 testid，当前值在 data-value 上；每个选项是 `${testid}-opt`，值在 data-value 上。
 */
export function SearchSelect({
  value,
  onChange,
  options,
  placeholder = "请选择",
  searchPlaceholder = "搜索…",
  emptyText = "没有匹配的选项",
  allowCustom,
  testid,
  className = "input",
  invalid,
  reqKey,
  disabled,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  allowCustom?: boolean;
  testid?: string;
  className?: string;
  invalid?: boolean;
  reqKey?: string;
  disabled?: boolean;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [up, setUp] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const cur = options.find(o => o.value === value);
  const shown = cur ? (cur.hint && cur.hint !== cur.label ? `${cur.label}（${cur.hint}）` : cur.label) : value;

  const items = useMemo(() => {
    const out = options.filter(o => matchOption(o, q));
    const t = q.trim();
    if (allowCustom && t && !options.some(o => o.value === t)) out.push({ value: t, label: `使用「${t}」`, group: "自定义" });
    return out;
  }, [options, q, allowCustom]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // 打开时：光标在搜索框、高亮当前值；下面放不下就往上开
  const openIt = () => {
    if (disabled) return;
    const r = box.current?.getBoundingClientRect();
    setUp(!!r && window.innerHeight - r.bottom < MAX_H + 60 && r.top > window.innerHeight - r.bottom);
    setQ("");
    setHi(Math.max(0, options.findIndex(o => o.value === value)));
    setOpen(true);
  };

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".hi")?.scrollIntoView({ block: "nearest" });
  }, [hi, open, q]);

  const pick = (o?: SelOption) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      let i = hi;
      for (let n = 0; n < items.length; n++) {
        i = (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        if (!items[i].disabled) break;
      }
      setHi(i);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(items[hi]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="ss" ref={box}>
      <button
        type="button"
        className={`${className} ss-trigger${mono ? " mono" : ""}${invalid ? " invalid" : ""}${open ? " on" : ""}`}
        data-req={reqKey}
        data-testid={testid}
        data-value={value}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openIt())}
      >
        <span className={`ss-val${shown ? "" : " ph"}`}>{shown || placeholder}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className={`ss-pop${up ? " up" : ""}`} data-testid={testid ? `${testid}-pop` : undefined} onKeyDown={onKey} onClick={e => e.preventDefault()}>
          <input
            className="input ss-search"
            data-testid={testid ? `${testid}-search` : undefined}
            autoFocus
            spellCheck={false}
            placeholder={searchPlaceholder}
            value={q}
            onChange={e => {
              setQ(e.target.value);
              setHi(0);
            }}
          />
          <div className="ss-list" role="listbox" ref={list} style={{ maxHeight: MAX_H }}>
            {items.map((o, i) => (
              <div key={`${o.group ?? ""}:${o.value}`}>
                {o.group && o.group !== items[i - 1]?.group && <div className="ss-group">{o.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  disabled={o.disabled}
                  data-testid={testid ? `${testid}-opt` : undefined}
                  data-value={o.value}
                  className={`ss-item${i === hi ? " hi" : ""}${o.value === value ? " sel" : ""}`}
                  onMouseMove={() => i !== hi && setHi(i)}
                  onClick={() => pick(o)}
                >
                  <span className="ss-name">{o.label}</span>
                  {o.hint && o.hint !== o.label && <span className="ss-hint">{o.hint}</span>}
                  {o.value === value && <Icon name="check" size={14} />}
                </button>
              </div>
            ))}
            {!items.length && <div className="ss-empty">{emptyText}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
