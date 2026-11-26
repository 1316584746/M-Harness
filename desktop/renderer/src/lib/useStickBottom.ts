import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** 离底部不到这么多像素，就算「停在底部」 */
const NEAR_PX = 48;

export interface StickOptions {
  /** 内容在变（流式输出、新事件）时跟着往下滚的依赖：只有用户停在底部才滚，往上翻过历史就不动 */
  follow?: readonly unknown[];
  /** 这个值变了就强制回到底部并重新「贴底」：切换对话 / 任务、用户自己发了新消息 */
  force?: unknown;
}

/**
 * 对话列表的滚动：
 * - 本来就停在底部：内容变多（AI 在输出）、输入框被拖高、窗口变矮，都继续贴着底部；
 * - 用户往上翻看历史：不再把人拽回底部（以前每来一个事件就往下跳，根本没法看上面）；
 * - 切换对话 / 任务、用户自己发新消息：回到底部。
 * 往上滚的判断不等 scroll 事件：滚轮向上、触摸拖动、PageUp / Home / 方向键向上，一发生就松开「贴底」，避免内容刚好在两次滚动之间变长又被拽回去。
 */
export function useStickBottom(ref: RefObject<HTMLElement | null>, opts: StickOptions = {}): void {
  const stuck = useRef(true);
  const follow = opts.follow ?? [];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const near = () => el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_PX;
    const onScroll = () => {
      stuck.current = near();
    };
    const release = () => {
      stuck.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) release();
    };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? touchY;
      if (y > touchY) release(); // 手指往下拖 = 内容往上走 = 在看更早的内容
      touchY = y;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp") release();
    };
    // 窗口变矮 / 输入框被拖高导致列表变短：停在底部的仍贴着底部，最后几行不会被下面的输入框遮住
    let h = el.clientHeight;
    const ro =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            const now = el.clientHeight;
            if (now < h && stuck.current) el.scrollTop = el.scrollHeight;
            h = now;
          });
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKey);
    ro?.observe(el);
    onScroll();
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKey);
      ro?.disconnect();
    };
  }, [ref]);

  // 切换 / 用户发新消息：回到底部并重新贴底（布局后立刻滚，不闪一下）
  useLayoutEffect(() => {
    const el = ref.current;
    stuck.current = true;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref, opts.force]);

  // 内容变多：只有停在底部才跟着滚
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...follow]);
}
