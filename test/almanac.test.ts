import { describe, expect, it } from "vitest";
import { almanacOf } from "../desktop/renderer/src/lib/almanac";

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 12);

describe("黄历", () => {
  it("国庆节：放假、有节日名、有宜忌", () => {
    const a = almanacOf(d(2026, 10, 1));
    expect(a.holiday).toEqual({ name: "国庆节", work: false });
    expect(a.festivals).toContain("国庆节");
    expect(a.label).toBe("国庆节");
    expect(a.yi.length).toBeGreaterThan(0);
    expect(a.ji.length).toBeGreaterThan(0);
  });

  it("调休补班日：标成补班，不当节日", () => {
    const a = almanacOf(d(2026, 10, 10));
    expect(a.holiday).toEqual({ name: "国庆节", work: true });
    expect(a.label).toBe("");
  });

  it("放假的第二天以后：格子里不重复写假期名，但仍标休", () => {
    const a = almanacOf(d(2026, 10, 3));
    expect(a.holiday?.work).toBe(false);
    expect(a.label).toBe("");
  });

  it("春节 / 除夕 / 节气", () => {
    expect(almanacOf(d(2026, 2, 17)).festivals).toContain("春节");
    expect(almanacOf(d(2026, 2, 16)).festivals).toContain("除夕");
    expect(almanacOf(d(2026, 12, 22)).festivals).toContain("冬至");
  });

  it("普通的一天：农历、干支、生肖，没有节日和假期", () => {
    const a = almanacOf(d(2026, 12, 25));
    expect(a.lunar).toBe("冬月十七");
    expect(a.year).toBe("丙午年 · 属马");
    expect(a.ganzhi).toBe("庚子月 癸酉日");
    expect(a.holiday).toBeUndefined();
  });
});
