import { describe, expect, it } from "vitest";
import { dayIndex, layoutBars, windowStart, DAY } from "../desktop/shared/schedule";

const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();

describe("排期窗口与布局", () => {
  it("windowStart：本周一 0 点，周日也算上一个周一", () => {
    expect(windowStart(at(2026, 11, 17, 10))).toBe(at(2026, 11, 16)); // 周二
    expect(windowStart(at(2026, 11, 16))).toBe(at(2026, 11, 16)); // 周一
    expect(windowStart(at(2026, 11, 22, 23))).toBe(at(2026, 11, 16)); // 周日
    expect(windowStart(at(2026, 11, 17), 1)).toBe(at(2026, 11, 23));
    expect(windowStart(at(2026, 11, 17), -1)).toBe(at(2026, 11, 9));
  });

  it("dayIndex：按整天算", () => {
    const w = at(2026, 11, 16);
    expect(dayIndex(at(2026, 11, 16, 23), w)).toBe(0);
    expect(dayIndex(at(2026, 11, 20, 1), w)).toBe(4);
    expect(dayIndex(w - DAY, w)).toBe(-1);
  });

  it("layoutBars：区间、截断、窗口外、未排期", () => {
    const w = at(2026, 11, 16);
    const items = [
      { id: "in", start: at(2026, 11, 17), end: at(2026, 11, 19) },
      { id: "cut", start: at(2026, 11, 10), end: at(2026, 11, 17) },
      { id: "cutR", start: at(2026, 11, 28), end: at(2026, 12, 5) },
      { id: "past", start: at(2026, 10, 1), end: at(2026, 10, 3) },
      { id: "future", start: at(2027, 1, 1), end: at(2027, 1, 3) },
      { id: "due", due: at(2026, 11, 18, 18) },
      { id: "none" },
      { id: "swap", start: at(2026, 11, 22), end: at(2026, 11, 20) },
    ];
    const r = layoutBars(items, w);
    expect(r.bars.map(b => [b.item.id, b.s, b.e, b.cutL, b.cutR])).toEqual([
      ["cut", 0, 1, true, false],
      ["in", 1, 3, false, false],
      ["due", 2, 2, false, false],
      ["swap", 4, 6, false, false],
      ["cutR", 12, 13, false, true],
    ]);
    expect(r.unscheduled.map(i => i.id)).toEqual(["none"]);
    expect(r.outside).toBe(2);
  });
});
