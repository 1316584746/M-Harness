import fs from "node:fs";
import path from "node:path";

export interface WinState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const file = (dir: string) => path.join(dir, "window-state.json");

export function loadWinState(dir: string): Partial<WinState> | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file(dir), "utf8"));
    if (!j || typeof j !== "object") return undefined;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
    const out: Partial<WinState> = { width: num(j.width), height: num(j.height), x: num(j.x), y: num(j.y), maximized: j.maximized === true };
    return out.width && out.height ? out : undefined;
  } catch {
    return undefined;
  }
}

export function saveWinState(dir: string, s: WinState): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file(dir), JSON.stringify(s));
  } catch {
    /* 存不了就算了，下次用默认大小 */
  }
}

/**
 * 上次的窗口位置要还在某个屏幕里才用（换了显示器 / 拔了外接屏，窗口会跑到看不见的地方）；
 * 大小不能小于最小尺寸。位置不可用时只保留大小，让系统自己摆。
 */
export function usableWinState(s: Partial<WinState> | undefined, displays: Rect[], min: { width: number; height: number }, def: { width: number; height: number }): WinState {
  if (!s?.width || !s.height) return { ...def };
  const width = Math.max(min.width, s.width);
  const height = Math.max(min.height, s.height);
  const base: WinState = { width, height, maximized: s.maximized };
  if (s.x === undefined || s.y === undefined) return base;
  // 窗口左上角附近 80x40 的一块要落在某个屏幕里，用户才拖得动标题栏
  const px = s.x + 80;
  const py = s.y + 40;
  const onScreen = displays.some(d => px >= d.x && px <= d.x + d.width && py >= d.y && py <= d.y + d.height);
  return onScreen ? { ...base, x: s.x, y: s.y } : base;
}
