/** 工作台「我的排期」：把待办按天排进一个固定宽度的时间窗口（纯函数，便于测试） */

export const DAY = 86_400_000;
export const WINDOW_DAYS = 14;

export interface Schedulable {
  start?: number;
  end?: number;
  due?: number;
}

export interface Bar<T> {
  item: T;
  /** 在窗口里的起止列（0 起，含） */
  s: number;
  e: number;
  /** 起点 / 终点被窗口截断了 */
  cutL: boolean;
  cutR: boolean;
}

export const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** 窗口起点：本周一 0 点，再按 weeks 周平移 */
export function windowStart(now: number, weeks = 0): number {
  const d = new Date(startOfDay(now));
  const back = (d.getDay() + 6) % 7; // 周一为 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back + weeks * 7).getTime();
}

/** 第几天（夏令时也按整天算） */
export const dayIndex = (ms: number, winStart: number): number => Math.round((startOfDay(ms) - winStart) / DAY);

export function layoutBars<T extends Schedulable>(items: T[], winStart: number, days = WINDOW_DAYS): { bars: Bar<T>[]; unscheduled: T[]; outside: number } {
  const bars: Array<Bar<T> & { a: number; b: number }> = [];
  const unscheduled: T[] = [];
  let outside = 0;
  for (const item of items) {
    const x = item.start ?? item.end ?? item.due;
    const y = item.end ?? item.due ?? item.start;
    if (x === undefined || y === undefined) {
      unscheduled.push(item);
      continue;
    }
    const a = Math.min(x, y);
    const b = Math.max(x, y);
    const s = dayIndex(a, winStart);
    const e = dayIndex(b, winStart);
    if (e < 0 || s >= days) {
      outside++;
      continue;
    }
    bars.push({ item, s: Math.max(0, s), e: Math.min(days - 1, e), cutL: s < 0, cutR: e >= days, a, b });
  }
  bars.sort((p, q) => p.a - q.a || p.b - q.b);
  return { bars: bars.map(({ a: _a, b: _b, ...bar }) => bar), unscheduled, outside };
}

/** 11/17 */
export const md = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

export const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
