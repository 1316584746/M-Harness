import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { cellText, isNull } from "../../lib/sqlText";

export interface GridCol {
  name: string;
  type: string;
  pk?: boolean;
  /** 字段注释：显示在类型下面 */
  comment?: string;
}

/** 类型名按大类上色：JSON 粉、uuid 橙、数字蓝、文本绿、时间紫、布尔青 */
const typeKind = (t: string): string => {
  const s = t.toLowerCase();
  if (/json/.test(s)) return "t-json";
  if (/uuid/.test(s)) return "t-uuid";
  if (/bool|^bit/.test(s)) return "t-bool";
  if (/time|date|year|interval/.test(s)) return "t-time";
  if (/int|serial|numeric|decimal|float|double|real|money/.test(s)) return "t-num";
  if (/char|text|enum|set|string|citext/.test(s)) return "t-str";
  return "";
};

export interface GridRow {
  cells: unknown[];
  /** 待提交的状态：改过 / 将删除 / 新增 */
  state?: "deleted" | "inserted";
  /** 哪些格子改过（待提交） */
  changed?: boolean[];
  /** 新增行里还没填的格子（显示成「默认」） */
  unset?: boolean[];
}

export interface GridSort {
  col: string;
  dir: "asc" | "desc";
}

const widthOf = (c: GridCol) => Math.min(300, Math.max(110, c.name.length * 9 + 44, c.type.length * 7 + 30));

/** 数据表格：固定表头、行号、列宽可拖、点表头排序、双击单元格编辑（由上层决定能不能改） */
export function DataGrid({
  columns,
  rows,
  rowStart = 0,
  sort,
  onSort,
  selected,
  onToggleRow,
  canEdit,
  onEdit,
  empty,
  testid,
  resetKey,
}: {
  /** 换了一批数据（刷新 / 翻页 / 换条件）时换一个值：清掉选中格和正在编辑的格子 */
  resetKey?: unknown;
  columns: GridCol[];
  rows: GridRow[];
  /** 第一行的行号减一（分页时用） */
  rowStart?: number;
  sort?: GridSort | null;
  onSort?: (col: string) => void;
  selected?: Set<number>;
  onToggleRow?: (i: number) => void;
  /** 这个格子能不能改 */
  canEdit?: (row: number, col: number) => boolean;
  onEdit?: (row: number, col: number, value: string | null) => void;
  empty?: string;
  testid?: string;
}) {
  const sig = columns.map(c => c.name).join("\u0001");
  const [widths, setWidths] = useState<number[]>(() => columns.map(widthOf));
  useEffect(() => setWidths(columns.map(widthOf)), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  type Ed = { r: number; c: number; text: string; nul: boolean };
  const [editing, setEditing0] = useState<Ed | null>(null);
  /** 提交时读这份：点「NULL」按钮后输入框被拆掉，不能再因为失焦又提交一次 */
  const edRef = useRef<Ed | null>(null);
  const setEditing = (e: Ed | null) => {
    edRef.current = e;
    setEditing0(e);
  };
  useEffect(() => {
    setSel(null);
    setEditing(null);
  }, [sig, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const drag = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = widths[i];
    const move = (ev: PointerEvent) => setWidths(w => w.map((x, k) => (k === i ? Math.max(60, Math.round(w0 + ev.clientX - x0)) : x)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const commit = (nul?: boolean) => {
    const e = edRef.current;
    if (!e) return;
    setEditing(null);
    onEdit?.(e.r, e.c, nul ?? e.nul ? null : e.text);
  };

  const total = widths.reduce((a, b) => a + b, 0) + 56;
  const cur = sel && rows[sel.r] ? rows[sel.r].cells[sel.c] : undefined;
  const curCol = sel ? columns[sel.c] : undefined;
  const longText = !isNull(cur) ? cellText(cur) : "";
  const copy = (t: string) => void navigator.clipboard?.writeText(t).catch(() => {});

  return (
    <div className="dg" data-testid={testid}>
      <div className="dg-scroll">
        <table className="dg-table" style={{ width: total }}>
          <colgroup>
            <col style={{ width: 56 }} />
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="dg-no">#</th>
              {columns.map((c, i) => (
                <th key={c.name + i} className={`dg-h ${onSort ? "sortable" : ""} ${sort?.col === c.name ? "sorted" : ""}`} onClick={() => onSort?.(c.name)} title={`${c.name}  ${c.type}`}>
                  <span className="dg-h-top">
                    <span className="dg-h-name">
                      {c.pk && <span className="dg-key">PK</span>}
                      {c.name}
                    </span>
                    {onSort && (
                      <span className="dg-h-tools">
                        {sort?.col === c.name ? <span className="dg-sort">{sort.dir === "asc" ? "↑" : "↓"}</span> : <Icon name="sort" size={13} />}
                      </span>
                    )}
                  </span>
                  <span className={`dg-h-type ${typeKind(c.type)}`}>{c.type}</span>
                  {c.comment && <span className="dg-h-cmt">{c.comment}</span>}
                  <span className="dg-resize" onPointerDown={e => drag(i, e)} onClick={e => e.stopPropagation()} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className={`${row.state ?? ""} ${selected?.has(r) ? "picked" : ""}`}>
                <td className="dg-no" onClick={() => onToggleRow?.(r)} title={onToggleRow ? "点一下选中这一行" : undefined}>
                  {row.state === "inserted" ? "+" : rowStart + r + 1}
                </td>
                {columns.map((c, ci) => {
                  const v = row.cells[ci];
                  const isEd = editing?.r === r && editing.c === ci;
                  const unset = row.unset?.[ci];
                  const editable = !!canEdit?.(r, ci);
                  return (
                    <td
                      key={ci}
                      className={`dg-c ${row.changed?.[ci] ? "changed" : ""} ${sel?.r === r && sel.c === ci ? "cur" : ""} ${editable ? "editable" : ""}`}
                      onClick={() => setSel({ r, c: ci })}
                      onDoubleClick={() => editable && setEditing({ r, c: ci, text: unset || isNull(v) ? "" : cellText(v), nul: false })}
                    >
                      {isEd ? (
                        <span className="dg-edit">
                          <input
                            autoFocus
                            value={editing.text}
                            onChange={e => setEditing({ ...editing, text: e.target.value, nul: false })}
                            onKeyDown={e => {
                              if (e.key === "Enter") commit();
                              else if (e.key === "Escape") setEditing(null);
                            }}
                            onBlur={() => commit()}
                          />
                          <button className="dg-null" title="设为 NULL" onMouseDown={e => (e.preventDefault(), commit(true))}>
                            NULL
                          </button>
                        </span>
                      ) : unset ? (
                        <span className="dg-default">默认</span>
                      ) : isNull(v) ? (
                        <span className="dg-nullv">NULL</span>
                      ) : (
                        <span className={typeof v === "number" ? "dg-num" : undefined}>{cellText(v)}</span>
                      )}
                      {!isEd && !unset && !isNull(v) && (
                        <button className="dg-info" title="查看完整内容" onClick={e => (e.stopPropagation(), setSel({ r, c: ci }))}>
                          <Icon name="info" size={11} />
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="dg-empty">{empty ?? "没有数据"}</div>}
      </div>
      {sel && curCol && !isNull(cur) && longText.length > 0 && (
        <div className="dg-detail" data-testid="dg-detail">
          <span className="dg-detail-name">{curCol.name}</span>
          <code className="dg-detail-val">{longText}</code>
          <button className="icon-btn" title="复制这个值" onClick={() => copy(longText)}>
            <Icon name="copy" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}