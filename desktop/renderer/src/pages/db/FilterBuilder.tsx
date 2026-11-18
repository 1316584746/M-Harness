import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { OPS, type Cond, type FilterOp, type SortKey } from "../../lib/filterSql";

export interface FbColumn {
  name: string;
  type: string;
}

/** 点外面或按 Esc 就关的弹层 */
export function Popover({ onClose, children, testid }: { onClose: () => void; children: ReactNode; testid?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-popover-anchor]")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div className="fb-pop" ref={ref} data-testid={testid}>
      {children}
    </div>
  );
}

/** 带搜索的字段下拉 */
export function FieldSelect({ value, columns, onChange, placeholder = "字段", testid }: { value: string; columns: FbColumn[]; onChange: (name: string) => void; placeholder?: string; testid?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [open]);
  const list = columns.filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="fb-field" ref={box}>
      <button type="button" className={`fb-sel ${value ? "" : "ph"}`} data-testid={testid} onClick={() => (setQ(""), setOpen(o => !o))}>
        <span>{value || placeholder}</span>
        <Icon name="down" size={12} />
      </button>
      {open && (
        <div className="fb-menu" data-testid="fb-menu">
          <div className="fb-menu-search">
            <Icon name="search" size={13} />
            <input autoFocus value={q} placeholder="搜索字段…" spellCheck={false} onChange={e => setQ(e.target.value)} />
          </div>
          <div className="fb-menu-list">
            {list.map(c => (
              <button
                type="button"
                key={c.name}
                className={c.name === value ? "on" : ""}
                data-testid="fb-opt"
                onClick={() => {
                  onChange(c.name);
                  setOpen(false);
                }}
              >
                <span>{c.name}</span>
                <em>{c.type}</em>
              </button>
            ))}
            {!list.length && <div className="fb-menu-empty">没有匹配的字段</div>}
          </div>
        </div>
      )}
    </div>
  );
}

let seq = 1;
export const newCond = (): Cond => ({ id: seq++, col: "", op: "eq", val: "", on: true });
export const newSort = (col = "", dir: "asc" | "desc" = "asc"): SortKey => ({ id: seq++, col, dir, on: true });

/** 筛选：一行一个条件（字段 / 运算符 / 值），可以停用或删除，「全部满足」或「任一满足」 */
export function WherePanel({
  columns,
  conds,
  join,
  onChange,
  onJoin,
  onApply,
  onClear,
  onClose,
}: {
  columns: FbColumn[];
  conds: Cond[];
  join: "and" | "or";
  onChange: (c: Cond[]) => void;
  onJoin: (j: "and" | "or") => void;
  onApply: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const set = (id: number, patch: Partial<Cond>) => onChange(conds.map(c => (c.id === id ? { ...c, ...patch } : c)));
  const rows = conds.length ? conds : [];
  return (
    <Popover onClose={onClose} testid="fb-where">
      <div className="fb-head">
        <b>筛选</b>
        <span className="fb-join">
          满足
          <select value={join} data-testid="fb-join" onChange={e => onJoin(e.target.value as "and" | "or")}>
            <option value="and">全部条件</option>
            <option value="or">任一条件</option>
          </select>
        </span>
        <span className="spacer" />
        <button className="link-btn" data-testid="fb-clear" onClick={onClear}>
          <Icon name="trash" size={12} /> 清除筛选
        </button>
      </div>
      {rows.map(c => {
        const def = OPS.find(o => o.id === c.op);
        return (
          <div key={c.id} className={`fb-row ${c.on ? "" : "off"}`} data-testid="fb-cond">
            <FieldSelect value={c.col} columns={columns} onChange={col => set(c.id, { col })} testid="fb-col" />
            <select className="fb-op" value={c.op} data-testid="fb-op" onChange={e => set(c.id, { op: e.target.value as FilterOp })}>
              {OPS.map(o => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              className="fb-val"
              data-testid="fb-val"
              value={c.val}
              disabled={!def?.value}
              placeholder={def?.value ? (c.op === "in" || c.op === "notin" ? "多个值用逗号分隔" : "值") : ""}
              spellCheck={false}
              onChange={e => set(c.id, { val: e.target.value })}
              onKeyDown={e => e.key === "Enter" && onApply()}
            />
            <button className="icon-btn sm" title={c.on ? "暂时停用这个条件" : "重新启用"} onClick={() => set(c.id, { on: !c.on })}>
              <Icon name={c.on ? "eye" : "eyeOff"} size={14} />
            </button>
            <button className="icon-btn sm" title="删除这个条件" data-testid="fb-del" onClick={() => onChange(conds.filter(x => x.id !== c.id))}>
              <Icon name="x" size={14} />
            </button>
          </div>
        );
      })}
      {!rows.length && <div className="fb-empty">还没有条件，点下面「新增条件」</div>}
      <div className="fb-foot">
        <button className="link-btn" data-testid="fb-add" onClick={() => onChange([...conds, newCond()])}>
          <Icon name="plus" size={12} /> 新增条件
        </button>
        <span className="spacer" />
        <button className="btn sm" data-testid="fb-reset" onClick={() => onChange([])}>
          重置条件
        </button>
        <button className="btn sm primary" data-testid="fb-apply" onClick={onApply}>
          应用筛选
        </button>
      </div>
    </Popover>
  );
}

/** 排序：一行一个字段，升序 / 降序，可多个字段 */
export function OrderPanel({ columns, sorts, onChange, onApply, onClear, onClose }: { columns: FbColumn[]; sorts: SortKey[]; onChange: (s: SortKey[]) => void; onApply: () => void; onClear: () => void; onClose: () => void }) {
  const set = (id: number, patch: Partial<SortKey>) => onChange(sorts.map(s => (s.id === id ? { ...s, ...patch } : s)));
  return (
    <Popover onClose={onClose} testid="fb-order">
      <div className="fb-head">
        <b>排序</b>
        <span className="spacer" />
        <button className="link-btn" data-testid="fb-sort-clear" onClick={onClear}>
          <Icon name="trash" size={12} /> 清除排序
        </button>
      </div>
      {sorts.map(s => (
        <div key={s.id} className={`fb-row ${s.on ? "" : "off"}`} data-testid="fb-sortrow">
          <FieldSelect value={s.col} columns={columns} placeholder="选择字段" onChange={col => set(s.id, { col })} testid="fb-sort-col" />
          <select className="fb-op short" value={s.dir} data-testid="fb-sort-dir" onChange={e => set(s.id, { dir: e.target.value as "asc" | "desc" })}>
            <option value="asc">ASC</option>
            <option value="desc">DESC</option>
          </select>
          <span className="spacer" />
          <button className="icon-btn sm" title={s.on ? "暂时停用" : "重新启用"} onClick={() => set(s.id, { on: !s.on })}>
            <Icon name={s.on ? "eye" : "eyeOff"} size={14} />
          </button>
          <button className="icon-btn sm" title="删除" onClick={() => onChange(sorts.filter(x => x.id !== s.id))}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      {!sorts.length && <div className="fb-empty">还没有排序字段，点下面「新增字段」</div>}
      <div className="fb-foot">
        <button className="link-btn" data-testid="fb-sort-add" onClick={() => onChange([...sorts, newSort()])}>
          <Icon name="plus" size={12} /> 新增字段
        </button>
        <span className="spacer" />
        <button className="btn sm" onClick={() => onChange([])}>
          重置排序
        </button>
        <button className="btn sm primary" data-testid="fb-sort-apply" onClick={onApply}>
          应用排序
        </button>
      </div>
    </Popover>
  );
}
