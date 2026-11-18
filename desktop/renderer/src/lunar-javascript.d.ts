declare module "lunar-javascript" {
  export interface Holiday {
    getName(): string;
    isWork(): boolean;
    getTarget(): string;
    getDay(): string;
  }
  export interface Lunar {
    getYearInGanZhi(): string;
    getMonthInGanZhi(): string;
    getDayInGanZhi(): string;
    getYearShengXiao(): string;
    getMonthInChinese(): string;
    getDayInChinese(): string;
    getFestivals(): string[];
    getOtherFestivals(): string[];
    getJieQi(): string;
    getDayYi(): string[];
    getDayJi(): string[];
    getDayChongDesc(): string;
    getDayShengXiao(): string;
  }
  export interface Solar {
    getFestivals(): string[];
    getOtherFestivals(): string[];
    getLunar(): Lunar;
    getXingZuo(): string;
  }
  export const Solar: { fromYmd(y: number, m: number, d: number): Solar };
  export const HolidayUtil: { getHoliday(y: number, m: number, d: number): Holiday | null };
}
