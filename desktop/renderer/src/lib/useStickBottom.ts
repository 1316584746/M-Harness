import { useEffect, type RefObject } from "react";

/**
 * 滚动区（对话列表）跟着可视高度自适应：本来就停在底部时，输入框被拖高 / 窗口变矮导致列表变短，
 * 仍然贴着底部，最后几行不会被下面的输入框遮住；用户往上翻过历史则不动。
 */
export function useStickBottom(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let stuck = true;
    const near = () => el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    const onScroll = () => {
      stuck = near();
    };
    let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const now = el.clientHeight;
      if (now < h && stuck) el.scrollTop = el.scrollHeight;
      h = now;
    });
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    onScroll();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [ref]);
}
