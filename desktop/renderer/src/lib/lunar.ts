/** 农历：用系统自带的 Intl 中国日历取月和日，再换成「初一、十五、廿三」这种写法 */

const DAY_NAMES = [
  "", "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
];

const fmt = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", { month: "long", day: "numeric" });

export interface Lunar {
  /** 月份，如「十月」「闰六月」 */
  month: string;
  /** 日，如「初八」 */
  day: string;
  /** 日历格子里显示的短文本：初一显示月份，其余显示日 */
  short: string;
}

export function lunarOf(d: Date): Lunar {
  const parts = fmt.formatToParts(d);
  const month = parts.find(p => p.type === "month")?.value ?? "";
  const n = Number(parts.find(p => p.type === "day")?.value ?? 0);
  const day = DAY_NAMES[n] ?? "";
  return { month, day, short: n === 1 ? month : day };
}
