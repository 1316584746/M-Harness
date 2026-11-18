import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { applyItem, complete, type CompItem, type CompResult, type CompSource } from "../../lib/sqlComplete";
import { statementMarks, toggleComment, tokenize } from "../../lib/sqlText";

/** 给外面的按钮用：改写全文并设置选区（格式化、注释）、取当前选区 */
export interface SqlEditorHandle {
  replace: (value: string, a: number, b: number) => void;
  selection: () => [number, number];
  focus: () => void;
}

interface Pop {
  res: CompResult;
  sel: number;
  x: number;
  /** 往上弹时用 bottom，往下弹时用 top */
  y: number;
  up: boolean;
}

const MAX_H = 232;

const GLYPH: Partial<Record<CompItem["kind"], string>> = { snippet: "{}", keyword: "<>", type: "<>", function: "ƒ" };
const ICON: Partial<Record<CompItem["kind"], IconName>> = { table: "grid", view: "eye", column: "list", schema: "folder" };

/** 在 textarea 里算出某个位置在屏幕上的坐标（等宽字体，不换行；Tab 按 tab-size 展开） */
function caretXY(t: HTMLTextAreaElement, pos: number): { x: number; top: number; bottom: number } {
  const cs = getComputedStyle(t);
  const lh = parseFloat(cs.lineHeight) || 20;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const tab = parseInt(cs.tabSize, 10) || 2;
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
  const cw = ctx?.measureText("0").width || 7.8;
  const lines = t.value.slice(0, pos).split("\n");
  let col = 0;
  for (const ch of lines[lines.length - 1]) col += ch === "\t" ? tab - (col % tab) : 1;
  const r = t.getBoundingClientRect();
  const top = r.top + padT + (lines.length - 1) * lh;
  return { x: r.left + padL + col * cw, top, bottom: top + lh };
}

/**
 * SQL 编辑器：行号 + 语法高亮 + 联想补齐。
 * 做法：一层高亮文字垫在下面，上面盖一个透明文字的 textarea 负责输入和光标。
 * 不依赖第三方编辑器库；Tab 缩进、Ctrl+Enter 运行、Ctrl+Space 手动唤起联想。
 */
interface SqlEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** Ctrl + Enter：运行光标所在的语句（选中了就运行选中的） */
  onRun: () => void;
  /** 行首的运行按钮：运行那一条语句 */
  onRunStatement?: (sql: string) => void;
  /** Ctrl + Shift + Enter：依次运行全部语句 */
  onRunAll?: () => void;
  onCaret?: (pos: number, selEnd: number) => void;
  placeholder?: string;
  testid?: string;
  /** 联想要用的库信息；没传就没有联想 */
  completion?: { src: CompSource; version: number };
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor({ value, onChange, onRun, onRunStatement, onRunAll, onCaret, placeholder, testid, completion }, ref) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const toks = useMemo(() => tokenize(value), [value]);
  const lines = value.split("\n").length;
  // 每条完整语句第一行的行首放一个运行按钮
  const marks = useMemo(() => new Map(statementMarks(value).map(m => [m.line, m])), [value]);
  const [pop, setPop] = useState<Pop | null>(null);
  const popRef = useRef<Pop | null>(null);
  popRef.current = pop;

  const caret = () => {
    const t = ta.current;
    if (t && onCaret) onCaret(t.selectionStart, t.selectionEnd);
  };

  useImperativeHandle(ref, () => ({
    replace: (v, a, b) => {
      onChange(v);
      setPop(null);
      requestAnimationFrame(() => {
        const t = ta.current;
        if (!t) return;
        t.focus();
        t.selectionStart = a;
        t.selectionEnd = b;
        caret();
      });
    },
    selection: () => [ta.current?.selectionStart ?? 0, ta.current?.selectionEnd ?? 0],
    focus: () => ta.current?.focus(),
  }));

  /** 按光标现在的位置重新算候选；算不出来就收起 */
  const refresh = (explicit = false) => {
    const t = ta.current;
    if (!t || !completion || t.selectionStart !== t.selectionEnd) return setPop(null);
    const res = complete(t.value, t.selectionStart, completion.src, explicit);
    if (!res) return setPop(null);
    const p = caretXY(t, res.from);
    const room = window.innerHeight - p.bottom;
    const up = room < MAX_H + 12 && p.top > room;
    setPop(old => {
      const keep = old && old.res.from === res.from && old.res.items[old.sel] ? res.items.findIndex(i => i.label === old.res.items[old.sel].label && i.kind === old.res.items[old.sel].kind) : -1;
      return { res, sel: keep >= 0 ? keep : 0, x: Math.max(8, Math.min(p.x, window.innerWidth - 400)), y: up ? window.innerHeight - p.top : p.bottom, up };
    });
  };

  // 字段 / 别的 schema 的表取回来了：弹着的话重新算
  useEffect(() => {
    if (popRef.current) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completion?.version]);

  // 选中项始终在可见范围内
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".on")?.scrollIntoView({ block: "nearest" });
  }, [pop?.sel, pop?.res]);

  const accept = (i: number) => {
    const t = ta.current;
    const p = popRef.current;
    const item = p?.res.items[i];
    if (!t || !p || !item) return;
    const r = applyItem(t.value, p.res, item);
    onChange(r.value);
    setPop(null);
    requestAnimationFrame(() => {
      t.focus();
      t.selectionStart = t.selectionEnd = r.caret;
      caret();
    });
  };

  return (
    <div className="sql-ed" data-testid={testid}>
      <div className="sql-ed-scroll">
        <div className="sql-gutter">
          {Array.from({ length: Math.max(lines, 20) }, (_, i) => {
            const m = marks.get(i);
            return (
              <div key={i}>
                {m && onRunStatement && (
                  <button
                    type="button"
                    className="sql-run"
                    data-testid="sql-run-stmt"
                    data-tip="运行这条语句"
                    aria-label="运行这条语句"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => onRunStatement(m.text)}
                  >
                    <Icon name="playOutline" size={11} />
                  </button>
                )}
                <span aria-hidden>{i < lines ? i + 1 : ""}</span>
              </div>
            );
          })}
        </div>
        <div className="sql-ed-body">
          <pre className="sql-hl" aria-hidden>
            {toks.map((t, i) => (t.k === "txt" ? t.s : <span key={i} className={`sq-${t.k}`}>{t.s}</span>))}
            {"\n"}
          </pre>
          <textarea
            ref={ta}
            className="sql-input"
            data-testid={testid ? `${testid}-input` : undefined}
            value={value}
            spellCheck={false}
            wrap="off"
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={placeholder}
            onChange={e => {
              const t = e.target;
              onChange(t.value);
              caret();
              if (!completion) return;
              // 输入了一个字母 / 数字 / 下划线 / 点 / 引号：自动弹；删除：已经弹着就跟着缩小；粘贴不弹
              const grew = t.value.length - value.length;
              const ch = t.value[t.selectionStart - 1] ?? "";
              if ((grew > 0 && grew <= 2 && /[\w$."`]/.test(ch)) || popRef.current) refresh();
            }}
            onSelect={caret}
            onClick={() => {
              caret();
              setPop(null);
            }}
            onBlur={() => setPop(null)}
            onKeyUp={e => {
              caret();
              if (popRef.current && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) refresh();
            }}
            onKeyDown={e => {
              const p = popRef.current;
              if (p && !e.ctrlKey && !e.metaKey && !e.altKey) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const n = p.res.items.length;
                  return setPop({ ...p, sel: (p.sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
                }
                if (e.key === "PageDown" || e.key === "PageUp") {
                  e.preventDefault();
                  return setPop({ ...p, sel: Math.max(0, Math.min(p.res.items.length - 1, p.sel + (e.key === "PageDown" ? 8 : -8))) });
                }
                if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
                  // 已经原样敲完了选中的那个词：回车就是回车，不替换
                  if (e.currentTarget.value.slice(p.res.from, p.res.to) === p.res.items[p.sel].insert) setPop(null);
                  else {
                    e.preventDefault();
                    return accept(p.sel);
                  }
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  return setPop(null);
                }
              }
              if (e.key === " " && e.ctrlKey && completion) {
                e.preventDefault();
                return refresh(true);
              }
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                setPop(null);
                if (e.shiftKey && onRunAll) onRunAll();
                else onRun();
              } else if (e.key === "/" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                const t = e.currentTarget;
                const r = toggleComment(value, t.selectionStart, t.selectionEnd);
                onChange(r.value);
                requestAnimationFrame(() => {
                  t.selectionStart = r.a;
                  t.selectionEnd = r.b;
                  caret();
                });
              } else if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                const t = e.currentTarget;
                const s = t.selectionStart;
                const next = value.slice(0, s) + "  " + value.slice(t.selectionEnd);
                onChange(next);
                requestAnimationFrame(() => {
                  t.selectionStart = t.selectionEnd = s + 2;
                  caret();
                });
              }
            }}
          />
        </div>
      </div>
      {pop && (
        <div className="sql-comp" data-testid="sql-comp" ref={list} style={pop.up ? { left: pop.x, bottom: pop.y, maxHeight: MAX_H } : { left: pop.x, top: pop.y, maxHeight: MAX_H }} onMouseDown={e => e.preventDefault()}>
          {pop.res.items.map((it, i) => (
            <div key={`${it.kind}:${it.label}`} className={`sql-comp-row ${i === pop.sel ? "on" : ""}`} data-testid="sql-comp-item" data-kind={it.kind} onMouseDown={() => accept(i)} onMouseMove={() => i !== pop.sel && setPop({ ...pop, sel: i })}>
              <span className={`sql-comp-ico k-${it.kind}`}>{ICON[it.kind] ? <Icon name={ICON[it.kind]!} size={12} /> : GLYPH[it.kind]}</span>
              <span className="sql-comp-label">
                {[...it.label].map((c, j) => (it.hits.includes(j) ? <b key={j}>{c}</b> : c))}
              </span>
              {it.detail && <span className="sql-comp-detail">{it.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
