/** 自动化任务：按计划自动让 Agent 执行一段指令。这里是纯函数（计划计算、描述、校验），主进程和界面共用。 */

export type Schedule =
  /** 每隔 N 分钟 */
  | { kind: "interval"; minutes: number }
  /** 每天 HH:MM */
  | { kind: "daily"; time: string }
  /** 每周的某几天（0 周日 … 6 周六）HH:MM */
  | { kind: "weekly"; days: number[]; time: string }
  /** 只在某个时刻运行一次 */
  | { kind: "once"; at: number };

export interface AutoRun {
  id: string;
  /** 开始时间 */
  at: number;
  finished?: number;
  status: "running" | "done" | "error" | "aborted";
  /** Agent 的最终回答（失败时是错误说明） */
  text: string;
  error?: string;
  traceFile?: string;
  /** 手动点「立即运行」触发的 */
  manual?: boolean;
}

export interface Automation {
  id: string;
  name: string;
  /** 每次运行时发给 Agent 的指令 */
  prompt: string;
  provider?: string;
  model?: string;
  /** 工作区目录；不填用默认工作区 */
  workspace?: string;
  /** read：只读，写入 / 执行类工具不给用，需要确认的操作一律拒绝；ask：需要时弹窗问你（没人在就一直等） */
  access: "read" | "ask";
  schedule: Schedule;
  enabled: boolean;
  /** 到这个时间后不再运行（自动变成已结束） */
  endAt?: number;
  /** 已结束：一次性任务跑完了，或者到了结束时间 */
  ended?: boolean;
  created: number;
  updated: number;
  nextRun?: number;
  runs: AutoRun[];
}

export type AutoStatus = "on" | "paused" | "ended";
export const STATUS_TEXT: Record<AutoStatus, string> = { on: "已开启", paused: "已暂停", ended: "已结束" };

export const statusOf = (a: Pick<Automation, "enabled" | "ended">): AutoStatus => (a.ended ? "ended" : a.enabled ? "on" : "paused");

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MIN_INTERVAL = 5;
export const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** 本地时间 HH:MM 在 day 当天的毫秒数 */
function at(day: Date, time: string): number {
  const m = TIME.exec(time)!;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[1]), Number(m[2])).getTime();
}

/** 在 after 之后的下一次运行时间；没有下一次（一次性已过）返回 undefined */
export function nextRun(s: Schedule, after: number): number | undefined {
  if (s.kind === "once") return s.at > after ? s.at : undefined;
  if (s.kind === "interval") return after + Math.max(MIN_INTERVAL, s.minutes) * 60_000;
  const days = s.kind === "daily" ? [0, 1, 2, 3, 4, 5, 6] : s.days;
  if (!days.length || !TIME.test(s.time)) return undefined;
  const base = new Date(after);
  for (let i = 0; i < 8; i++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    if (!days.includes(day.getDay())) continue;
    const t = at(day, s.time);
    if (t > after) return t;
  }
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const fmtWhen = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 「每天 09:00」「每周一、三、五 18:30」「每 2 小时」「2026年11月20日 09:00 运行一次」 */
export function describeSchedule(s: Schedule): string {
  if (s.kind === "daily") return `每天 ${s.time}`;
  if (s.kind === "weekly") {
    const d = [...s.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const text = d.length === 7 ? "每天" : d.length === 5 && [1, 2, 3, 4, 5].every(x => d.includes(x)) ? "工作日" : `每周${d.map(x => WEEK[x]).join("、")}`;
    return `${text} ${s.time}`;
  }
  if (s.kind === "interval") return s.minutes % 60 === 0 ? `每 ${s.minutes / 60} 小时` : `每 ${s.minutes} 分钟`;
  const d = new Date(s.at);
  return `${d.getFullYear()}年${fmtWhen(s.at)} 运行一次`;
}

/** 校验用户填的内容；返回错误说明，没问题返回 undefined */
export function validateAutomation(a: Partial<Automation>): string | undefined {
  if (!a.name?.trim()) return "请填写任务名称";
  if (!a.prompt?.trim()) return "请填写要让 Agent 做什么";
  if (a.prompt.length > 20_000) return "指令太长了（最多 2 万字）";
  const s = a.schedule;
  if (!s) return "请选择运行计划";
  if (s.kind === "interval" && !(Number.isInteger(s.minutes) && s.minutes >= MIN_INTERVAL && s.minutes <= 60 * 24 * 30)) return `间隔最少 ${MIN_INTERVAL} 分钟`;
  if ((s.kind === "daily" || s.kind === "weekly") && !TIME.test(s.time)) return "时间格式不对，应该是 09:30 这样";
  if (s.kind === "weekly" && (!s.days.length || s.days.some(d => !Number.isInteger(d) || d < 0 || d > 6))) return "请至少选一个星期几";
  if (s.kind === "once" && !(Number.isFinite(s.at) && s.at > 0)) return "请选择运行的日期和时间";
  if (a.endAt !== undefined && !Number.isFinite(a.endAt)) return "结束时间不对";
  return undefined;
}
