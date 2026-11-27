import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FileChangeDTO } from "../../../shared/api";
import { api } from "../api";
import { highlight } from "../lib/highlight";
import { langOf, parsePatch, sumChanges } from "../lib/diffView";
import { Icon } from "./Icon";

const POP_W = 760;
const POP_H = 380;

/** 一个文件的改动预览：行号 + 增删底色 + 语法高亮 */
function DiffPreview({ file, patch }: { file: FileChangeDTO; patch: string | undefined }) {
  const lang = useMemo(() => langOf(file.path), [file.path]);
  const lines = useMemo(() => (patch ? parsePatch(patch) : []), [patch]);
  const empty = file.binary ? "二进制文件，不显示内容" : patch === undefined ? "加载中…" : lines.length ? "" : "没有保存这个文件的改动内容（太久以前的，或改动太大）";
  return (
    <>
      <div className="cc-pop-head" title={file.path}>
        {file.path}
      </div>
      <div className={`cc-diff${file.status === "A" ? " new" : file.status === "D" ? " del" : ""}`}>
        {empty && <div className="cc-empty">{empty}</div>}
        {lines.map((l, i) =>
          l.kind === "hunk" ? (
            <div key={i} className="cc-l hunk">
              <span className="cc-no" />
              <span className="cc-sign" />
              <span className="cc-code">{l.text}</span>
            </div>
          ) : l.kind === "note" ? (
            <div key={i} className="cc-l hunk">
              <span className="cc-no" />
              <span className="cc-sign" />
              <span className="cc-code">{l.text}</span>
            </div>
          ) : (
            <div key={i} className={`cc-l ${l.kind}`}>
              <span className="cc-no">{l.kind === "del" ? l.old : l.new}</span>
              <span className="cc-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}</span>
              <span className="cc-code">
                {highlight(l.text, lang).map((t, k) => (t.c ? <span key={k} className={`tk-${t.c}`}>{t.s}</span> : <Fragment key={k}>{t.s}</Fragment>))}
              </span>
            </div>
          ),
        )}
      </div>
    </>
  );
}

/**
 * 「已编辑 N 个文件 +增 -删」：AI 这一轮改了哪些文件；鼠标放到某一行，弹出这个文件的改动（行号、增删底色、高亮）。
 * diff 正文不随对话保存，第一次放上去时才向主进程要。
 */
export function ChangesCard({ runId, changes }: { runId?: string; changes: FileChangeDTO[] }) {
  const total = useMemo(() => sumChanges(changes), [changes]);
  const [hover, setHover] = useState<{ file: FileChangeDTO; rect: DOMRect } | null>(null);
  const [patches, setPatches] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelClose = () => clearTimeout(timer.current);
  const closeSoon = () => {
    cancelClose();
    timer.current = setTimeout(() => setHover(null), 160);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const show = useCallback(
    (file: FileChangeDTO, el: HTMLElement) => {
      cancelClose();
      setHover({ file, rect: el.getBoundingClientRect() });
      if (file.binary || patches[file.path] !== undefined) return;
      if (!runId) {
        setPatches(p => ({ ...p, [file.path]: "" }));
        return;
      }
      void api
        .runChangePatch(runId, file.path)
        .catch(() => "")
        .then(txt => setPatches(p => ({ ...p, [file.path]: txt })));
    },
    [runId, patches],
  );

  if (!changes.length) return null;

  // 弹层位置：在这一行上方（上面放不下就放下面），横向不超出窗口
  const pop = hover
    ? (() => {
        const w = Math.min(POP_W, window.innerWidth - 24);
        const left = Math.max(12, Math.min(hover.rect.left, window.innerWidth - w - 12));
        const above = hover.rect.top > POP_H + 24;
        return { left, width: w, ...(above ? { bottom: window.innerHeight - hover.rect.top + 6 } : { top: hover.rect.bottom + 6 }) };
      })()
    : null;

  return (
    <div className="cc" data-testid="changes-card">
      <div className="cc-head">
        <span className="cc-ico">
          <Icon name="edit" size={16} />
        </span>
        <div className="cc-title">
          <b>已编辑 {changes.length} 个文件</b>
          <span className="cc-sum">
            <i className="add">+{total.added}</i> <i className="del">-{total.removed}</i>
          </span>
        </div>
      </div>
      <div className="cc-list">
        {changes.map(f => (
          <div key={f.path} className={`cc-row${hover?.file.path === f.path ? " on" : ""}`} data-testid="changes-row" onMouseEnter={e => show(f, e.currentTarget)} onMouseLeave={closeSoon}>
            <span className="cc-path" title={f.path}>
              {f.path}
            </span>
            {f.status === "D" && <span className="cc-tag">已删除</span>}
            {f.binary ? (
              <span className="cc-tag">二进制</span>
            ) : (
              <span className="cc-num">
                <i className="add">+{f.added}</i> <i className="del">-{f.removed}</i>
              </span>
            )}
          </div>
        ))}
      </div>
      {hover && pop && createPortal(
        <div className="cc-pop" style={pop} onMouseEnter={cancelClose} onMouseLeave={closeSoon} data-testid="changes-pop">
          <DiffPreview file={hover.file} patch={hover.file.binary ? "" : patches[hover.file.path]} />
        </div>,
        document.body,
      )}
    </div>
  );
}
