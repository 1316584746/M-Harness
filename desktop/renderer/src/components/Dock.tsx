import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * 底部 Dock（仿 macOS）：
 *  - 鼠标划过时，图标按距离放大，像水波一样一圈圈传开，旁边的图标被挤开；
 *  - 当前所在的页面图标常驻放大一点，下面有一个小点；
 *  - 划到哪个图标、点哪个图标，图标上会漾开一圈水波；
 *  - 悬停时在图标上方显示名字。
 */

export interface DockItem {
  id: string;
  testid: string;
  label: string;
  icon: IconName;
  /** 图标底色的色相（0–360），每个应用一个颜色 */
  hue: number;
  on?: boolean;
  /** 右上角红色数字（如待处理缺陷） */
  badge?: number | string;
  badgeNew?: boolean;
  /** 右上角小圆点（如助手在跑 / 通道在线） */
  dot?: "ok" | "update";
  onClick: () => void;
}

const BASE = 40; // 图标边长（px）
const MAX = 1.72; // 鼠标正下方的图标放大到几倍
const SIGMA = 46; // 水波的宽度：越大，影响的图标越多
const ON_BOOST = 1.12; // 当前页面的图标常驻放大
/** 高斯衰减：离鼠标越远放得越小，形成一圈圈的波 */
export function dockScale(dist: number): number {
  return 1 + (MAX - 1) * Math.exp(-(dist * dist) / (2 * SIGMA * SIGMA));
}

interface Ripple {
  key: number;
  id: string;
  x: number;
  y: number;
  soft: boolean;
}

export function Dock({ groups }: { groups: DockItem[][] }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const flat = groups.flat();
  /** 鼠标不在 Dock 上时为 null；否则是每个图标的放大倍数 */
  const [scales, setScales] = useState<number[] | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const rippleKey = useRef(0);
  const lastHover = useRef<string | null>(null);

  const onMove = useCallback((e: React.MouseEvent) => {
    const row = rowRef.current;
    if (!row) return;
    const left = row.getBoundingClientRect().left;
    const x = e.clientX - left;
    const next: number[] = [];
    row.querySelectorAll<HTMLElement>("[data-dock-i]").forEach(el => {
      // offsetLeft 不受 transform 影响：用没放大时的位置算距离，放大过程中不会来回抖
      next.push(dockScale(Math.abs(el.offsetLeft + el.offsetWidth / 2 - x)));
    });
    setScales(next);
  }, []);

  const leave = useCallback(() => {
    setScales(null);
    lastHover.current = null;
  }, []);

  const addRipple = useCallback((id: string, e: React.MouseEvent, soft: boolean) => {
    const el = e.currentTarget.querySelector<HTMLElement>(".dock-tile");
    if (!el) return;
    const r = el.getBoundingClientRect();
    const key = ++rippleKey.current;
    // 坐标换成相对图标自身（没放大时）的位置
    const k = r.width / BASE || 1;
    setRipples(list => [...list.slice(-6), { key, id, x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k, soft }]);
    window.setTimeout(() => setRipples(list => list.filter(x => x.key !== key)), 900);
  }, []);

  useEffect(() => () => setRipples([]), []);

  // 每个图标要往两边挪多少，让放大的图标把邻居挤开而不是盖住它们
  const sc = flat.map((it, i) => (scales?.[i] ?? 1) * (it.on ? ON_BOOST : 1));
  const extra = sc.map(s => BASE * (s - 1));
  const total = extra.reduce((a, b) => a + b, 0);
  let acc = 0;
  const shift = extra.map(x => {
    const v = acc + x / 2 - total / 2;
    acc += x;
    return v;
  });
  // 名字提示：鼠标最靠近的那个
  let hot = -1;
  if (scales) {
    let best = 1.12;
    scales.forEach((s, i) => {
      if (s > best) {
        best = s;
        hot = i;
      }
    });
  }
  const hotItem = hot >= 0 ? flat[hot] : null;
  const hotEl = hotItem ? rowRef.current?.querySelector<HTMLElement>(`[data-dock-i="${hot}"]`) : null;
  const tipX = hotEl ? hotEl.offsetLeft + hotEl.offsetWidth / 2 + shift[hot] : 0;

  let idx = -1;
  return (
    <div className="dock-wrap" data-testid="dock">
      <nav className="dock" aria-label="应用栏" style={{ "--dock-extra": `${total}px` } as React.CSSProperties}>
        <div className="dock-row" ref={rowRef} onMouseMove={onMove} onMouseLeave={leave}>
          {groups.map((g, gi) => (
            <div className="dock-group" key={gi}>
              {gi > 0 && <span className="dock-sep" aria-hidden />}
              {g.map(it => {
                idx++;
                const i = idx;
                const s = sc[i];
                return (
                  <button
                    key={it.id}
                    type="button"
                    data-dock-i={i}
                    data-testid={it.testid}
                    aria-label={it.label}
                    aria-current={it.on ? "page" : undefined}
                    className={`dock-item ${it.on ? "on" : ""}`}
                    style={{ width: BASE, height: BASE, transform: `translateX(${shift[i]}px) scale(${s})` }}
                    onMouseEnter={e => {
                      if (lastHover.current !== it.id) {
                        lastHover.current = it.id;
                        addRipple(it.id, e, true);
                      }
                    }}
                    onClick={e => {
                      addRipple(it.id, e, false);
                      it.onClick();
                    }}
                  >
                    <span className="dock-tile" style={{ "--h": it.hue } as React.CSSProperties}>
                      <Icon name={it.icon} size={24} />
                      {ripples
                        .filter(r => r.id === it.id)
                        .map(r => (
                          <span key={r.key} className={`dock-ripple ${r.soft ? "soft" : ""}`} style={{ left: r.x, top: r.y }} />
                        ))}
                    </span>
                    {it.badge !== undefined && it.badge !== 0 && (
                      <span className={`dock-badge ${it.badgeNew ? "new" : ""}`} data-testid={it.id === "defects" ? "defect-badge" : undefined}>
                        {typeof it.badge === "number" && it.badge > 99 ? "99+" : it.badge}
                      </span>
                    )}
                    {it.dot && <span className={`dock-dot ${it.dot}`} />}
                    {it.on && <span className="dock-on" />}
                  </button>
                );
              })}
            </div>
          ))}
          {hotItem && (
            <span className="dock-tip" style={{ left: tipX }}>
              {hotItem.label}
            </span>
          )}
        </div>
      </nav>
    </div>
  );
}
