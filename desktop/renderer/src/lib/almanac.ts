/// <reference path="../lunar-javascript.d.ts" />
import { HolidayUtil, Solar } from "lunar-javascript";

/**
 * 黄历：农历、节日、节气、法定假日 / 调休补班、每日宜忌。全部本地计算（lunar-javascript），不联网。
 * 法定假日和调休的数据随这个库更新；库里没有的年份，不显示休 / 班。
 */

export interface Almanac {
  /** 冬月十七 */
  lunar: string;
  /** 丙午年 · 属马 */
  year: string;
  /** 己亥月 甲寅日 */
  ganzhi: string;
  /** 节日（公历 / 农历的主要节日，加上节气） */
  festivals: string[];
  /** 其他纪念日（不放假的，比如国际老年人日） */
  minor: string[];
  /** 法定节假日 / 调休补班 */
  holiday?: { name: string; work: boolean };
  /** 每天要显示在日历格子里的名字：节日 > 节气 > 假期首日 > 空 */
  label: string;
  yi: string[];
  ji: string[];
}

export function almanacOf(d: Date): Almanac {
  const s = Solar.fromYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const l = s.getLunar();
  const h = HolidayUtil.getHoliday(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const jie = l.getJieQi();
  const festivals = [...new Set([...s.getFestivals(), ...l.getFestivals(), ...(jie ? [jie] : [])])];
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const holiday = h ? { name: h.getName(), work: h.isWork() } : undefined;
  // 格子很窄：只放得下 4 个字以内的名字，长的（世界住房日…）只在停留的卡片里显示
  const label = festivals.find(f => f.length <= 4) ?? (h && !h.isWork() && h.getTarget() === key ? h.getName() : "");
  return {
    lunar: `${l.getMonthInChinese()}月${l.getDayInChinese()}`,
    year: `${l.getYearInGanZhi()}年 · 属${l.getYearShengXiao()}`,
    ganzhi: `${l.getMonthInGanZhi()}月 ${l.getDayInGanZhi()}日`,
    festivals,
    minor: [...new Set([...s.getOtherFestivals(), ...l.getOtherFestivals()])],
    holiday,
    label,
    yi: l.getDayYi(),
    ji: l.getDayJi(),
  };
}
