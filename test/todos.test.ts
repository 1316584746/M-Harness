import { describe, expect, it } from "vitest";
import { pickTodayTodos } from "../desktop/shared/todos";

const now = new Date(2026, 10, 18, 14, 0); // 2026-11-18 14:00
const at = (d: number, h = 18, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const t = (o: Record<string, unknown>) => ({ id: String(o.title), groupId: "g", priority: "medium", done: false, subtasks: [], ...o });

describe("首页今日待办：挑选", () => {
  it("没做完的：逾期、今天截止、今天开始；其它不要", () => {
    const data = {
      groups: [{ id: "g", name: "工作" }],
      tasks: [
        t({ title: "逾期", dueAt: at(15) }),
        t({ title: "今天晚上", dueAt: at(18, 20) }),
        t({ title: "今天早上已过", dueAt: at(18, 9) }),
        t({ title: "今天开始", startAt: at(18, 16), dueAt: at(25) }),
        t({ title: "明天", dueAt: at(19) }),
        t({ title: "昨天开始还没截止", startAt: at(17), dueAt: at(25) }),
        t({ title: "没日期" }),
        t({ title: "已完成", dueAt: at(15), done: true }),
        t({ title: "  ", dueAt: at(15) }),
      ],
    };
    const r = pickTodayTodos(data, now);
    expect(r.map(x => x.title)).toEqual(["逾期", "今天早上已过", "今天晚上", "今天开始"]);
    expect(r[0]).toMatchObject({ kind: "overdue", days: 3, group: "工作" });
    expect(r[1]).toMatchObject({ kind: "today", late: true });
    expect(r[2]).toMatchObject({ kind: "today", late: false });
    expect(r[3].kind).toBe("start");
  });

  it("同一类里按优先级再按时间；带子任务进度", () => {
    const r = pickTodayTodos(
      {
        tasks: [
          t({ title: "低-早", priority: "low", dueAt: at(18, 15) }),
          t({ title: "高-晚", priority: "high", dueAt: at(18, 23) }),
          t({ title: "中-有子任务", dueAt: at(18, 16), subtasks: [{ done: true }, { done: false }, { done: true }] }),
        ],
      },
      now,
    );
    expect(r.map(x => x.title)).toEqual(["高-晚", "中-有子任务", "低-早"]);
    expect(r[1].sub).toEqual({ done: 2, total: 3 });
  });

  it("数据不对劲时不抛异常", () => {
    expect(pickTodayTodos(null, now)).toEqual([]);
    expect(pickTodayTodos({ tasks: "x" }, now)).toEqual([]);
    expect(pickTodayTodos({ tasks: [null, 1, { title: "a", dueAt: "不是日期" }] }, now)).toEqual([]);
  });
});
