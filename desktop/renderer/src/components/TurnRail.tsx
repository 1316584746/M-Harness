import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Turn } from "../lib/chatStore";
import { activeIndex, railItems } from "../lib/turnRail";

/**
 * 对话右侧的「提问导航」：每个提问一根短横线，当前所在的那根更长更亮；
 * 鼠标放上去显示这一问和回答的摘要，点一下跳到那一问。提问不到 2 个不显示。
 */
export function TurnRail({ scroller, turns }: { scroller: RefObject<HTMLElement | null>; turns: Turn[] }) {
  const items = useMemo(() => railItems(turns), [turns]);
  const [cur, setCur] = useState(0);
  const raf = useRef(0);
  const n = items.length;

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top;
    const tops = items.map(it => {
      const node = el.querySelector<HTMLElement>(`[data-turn="${CSS.escape(it.id)}"]`);
      return node ? node.getBoundingClientRect().top - base : Infinity;
    });
    // 滚到底了就算最后一问（最后一问的回答很长时，它的顶部早就滚出去了，这样底部也能高亮最后一根）
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    setCur(atBottom && n > 0 ? n - 1 : activeIndex(tops, 0));
  }, [scroller, items, n]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const on = () => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(measure);
    };
    el.addEventListener("scroll", on, { passive: true });
    on();
    return () => {
      el.removeEventListener("scroll", on);
      cancelAnimationFrame(raf.current);
    };
  }, [scroller, measure]);

  if (n < 2) return null;
  const go = (id: string) => scroller.current?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });

  return (
    <nav className="turn-rail" aria-label="提问导航" data-testid="turn-rail">
      {items.map((it, i) => (
        <button key={it.id} type="button" className={`tr-tick${i === cur ? " on" : ""}`} onClick={() => go(it.id)} aria-label={`第 ${i + 1} 问：${it.ask}`} data-testid="turn-rail-tick">
          <span className="tr-line" />
          <span className="tr-card">
            <b>{it.ask}</b>
            {it.reply && <em>{it.reply}</em>}
          </span>
        </button>
      ))}
    </nav>
  );
}
