import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationEngine, type Runner } from "../desktop/main/automation";
import { describeSchedule, nextRun, statusOf, validateAutomation, type Schedule } from "../desktop/shared/automation";

const L = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();

describe("运行计划", () => {
  it("每天：今天还没到就是今天，过了就是明天", () => {
    const s: Schedule = { kind: "daily", time: "09:30" };
    expect(nextRun(s, L(2026, 11, 18, 8, 0))).toBe(L(2026, 11, 18, 9, 30));
    expect(nextRun(s, L(2026, 11, 18, 9, 30))).toBe(L(2026, 11, 19, 9, 30));
    expect(nextRun(s, L(2026, 11, 18, 23, 0))).toBe(L(2026, 11, 19, 9, 30));
  });
  it("每周：只在选中的星期几（2026-11-18 是周三）", () => {
    const s: Schedule = { kind: "weekly", days: [1, 5], time: "18:00" };
    expect(nextRun(s, L(2026, 11, 18, 10))).toBe(L(2026, 11, 20, 18)); // 周五
    expect(nextRun(s, L(2026, 11, 20, 19))).toBe(L(2026, 11, 23, 18)); // 下周一
    expect(nextRun({ kind: "weekly", days: [], time: "18:00" }, 0)).toBeUndefined();
  });
  it("间隔和一次性", () => {
    expect(nextRun({ kind: "interval", minutes: 30 }, 1000)).toBe(1000 + 30 * 60_000);
    expect(nextRun({ kind: "once", at: 5000 }, 1000)).toBe(5000);
    expect(nextRun({ kind: "once", at: 5000 }, 5000)).toBeUndefined();
  });
  it("描述", () => {
    expect(describeSchedule({ kind: "daily", time: "09:00" })).toBe("每天 09:00");
    expect(describeSchedule({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" })).toBe("工作日 09:00");
    expect(describeSchedule({ kind: "weekly", days: [3, 1, 0], time: "18:30" })).toBe("每周一、三、日 18:30");
    expect(describeSchedule({ kind: "interval", minutes: 120 })).toBe("每 2 小时");
    expect(describeSchedule({ kind: "interval", minutes: 45 })).toBe("每 45 分钟");
    expect(describeSchedule({ kind: "once", at: L(2026, 11, 20, 9) })).toBe("2026年11月20日 09:00 运行一次");
  });
  it("校验", () => {
    const ok = { name: "n", prompt: "p", schedule: { kind: "daily", time: "09:00" } } as const;
    expect(validateAutomation(ok)).toBeUndefined();
    expect(validateAutomation({ ...ok, name: " " })).toContain("名称");
    expect(validateAutomation({ ...ok, prompt: "" })).toContain("做什么");
    expect(validateAutomation({ ...ok, schedule: { kind: "daily", time: "25:00" } })).toContain("时间");
    expect(validateAutomation({ ...ok, schedule: { kind: "interval", minutes: 1 } })).toContain("最少");
    expect(validateAutomation({ ...ok, schedule: { kind: "weekly", days: [], time: "09:00" } })).toContain("星期");
  });
  it("状态", () => {
    expect(statusOf({ enabled: true })).toBe("on");
    expect(statusOf({ enabled: false })).toBe("paused");
    expect(statusOf({ enabled: true, ended: true })).toBe("ended");
  });
});

describe("自动化引擎", () => {
  const dirs: string[] = [];
  const mk = (runner: Runner, clock: { t: number }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-"));
    dirs.push(dir);
    const file = path.join(dir, "automations.json");
    let changes = 0;
    const eng = new AutomationEngine(file, runner, () => changes++, () => clock.t);
    return { eng, file, dir, changes: () => changes, reopen: (r: Runner = runner) => new AutomationEngine(file, r, () => {}, () => clock.t) };
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const base = { name: "日报", prompt: "总结今天", schedule: { kind: "daily", time: "09:00" } } as const;

  it("新建：算好下一次运行，存盘，重开还在", () => {
    const clock = { t: L(2026, 11, 18, 8) };
    const { eng, reopen } = mk(async () => ({ status: "done", text: "" }), clock);
    const r = eng.saveItem(base);
    expect(r.ok).toBe(true);
    expect(eng.get(r.id!)).toMatchObject({ enabled: true, access: "read", nextRun: L(2026, 11, 18, 9) });
    expect(reopen().list().map(a => a.name)).toEqual(["日报"]);
    expect(eng.saveItem({ ...base, name: "" }).ok).toBe(false);
  });

  it("到点才运行，运行后记录结果并算下一次", async () => {
    const clock = { t: L(2026, 11, 18, 8) };
    const calls: string[] = [];
    const { eng } = mk(async a => (calls.push(a.prompt), { status: "done", text: "今天做了三件事", traceFile: "t.jsonl" }), clock);
    const id = eng.saveItem(base).id!;
    eng.tick();
    await eng.idle();
    expect(calls).toEqual([]); // 8 点还没到
    clock.t = L(2026, 11, 18, 9, 0) + 5000;
    eng.tick();
    await eng.idle();
    expect(calls).toEqual(["总结今天"]);
    const a = eng.get(id)!;
    expect(a.runs[0]).toMatchObject({ status: "done", text: "今天做了三件事", traceFile: "t.jsonl" });
    expect(a.nextRun).toBe(L(2026, 11, 19, 9));
    eng.tick();
    await eng.idle();
    expect(calls.length).toBe(1); // 同一次不会重复触发
  });

  it("一次性任务：跑完变成已结束；暂停的不运行", async () => {
    const clock = { t: L(2026, 11, 18, 8) };
    let n = 0;
    const { eng } = mk(async () => (n++, { status: "done", text: "ok" }), clock);
    const id = eng.saveItem({ ...base, schedule: { kind: "once", at: L(2026, 11, 18, 10) } }).id!;
    const paused = eng.saveItem({ ...base, name: "暂停的", enabled: false }).id!;
    clock.t = L(2026, 11, 18, 11);
    eng.tick();
    await eng.idle();
    expect(n).toBe(1);
    expect(statusOf(eng.get(id)!)).toBe("ended");
    expect(eng.get(id)!.nextRun).toBeUndefined();
    expect(eng.get(paused)!.runs).toEqual([]);
    expect(eng.setEnabled(id, true).ok).toBe(false); // 一次性已过期，不能直接开启
  });

  it("立即运行：不影响原计划；失败会记下原因；同时只跑一次", async () => {
    const clock = { t: L(2026, 11, 18, 8) };
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let fail = false;
    const { eng } = mk(async () => {
      await gate;
      return fail ? { status: "error", text: "", error: "模型没配 Key" } : { status: "done", text: "好了" };
    }, clock);
    const id = eng.saveItem(base).id!;
    const next = eng.get(id)!.nextRun;
    expect(eng.runNow(id).ok).toBe(true);
    expect(eng.runNow(id).ok).toBe(false);
    expect(eng.isRunning(id)).toBe(true);
    release();
    await eng.idle();
    expect(eng.get(id)!.runs[0]).toMatchObject({ status: "done", manual: true });
    expect(eng.get(id)!.nextRun).toBe(next);
    fail = true;
    eng.runNow(id);
    await eng.idle();
    expect(eng.get(id)!.runs[0]).toMatchObject({ status: "error", text: "模型没配 Key" });
  });

  it("多个任务串行执行；运行里抛异常也不崩", async () => {
    const clock = { t: L(2026, 11, 18, 8) };
    let live = 0;
    let peak = 0;
    const { eng } = mk(async a => {
      live++;
      peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 10));
      live--;
      if (a.name === "坏的") throw new Error("boom");
      return { status: "done", text: "x" };
    }, clock);
    const a = eng.saveItem(base).id!;
    const b = eng.saveItem({ ...base, name: "坏的" }).id!;
    eng.runNow(a);
    eng.runNow(b);
    await eng.idle();
    expect(peak).toBe(1);
    expect(eng.get(b)!.runs[0]).toMatchObject({ status: "error", text: "boom" });
  });

  it("重启：关着应用错过的不补跑，上次没跑完的记为中断", async () => {
    const clock = { t: L(2026, 11, 18, 8) };
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const { eng, reopen } = mk(() => gate.then(() => ({ status: "done" as const, text: "" })), clock);
    const id = eng.saveItem(base).id!;
    eng.runNow(id);
    await new Promise(r => setTimeout(r, 5)); // 运行中，已经存盘
    clock.t = L(2026, 11, 20, 12); // 隔了两天才重新打开
    let ran = 0;
    const eng2 = reopen(async () => (ran++, { status: "done", text: "" }));
    eng2.tick();
    await eng2.idle();
    expect(ran).toBe(0);
    expect(eng2.get(id)!.runs[0].status).toBe("aborted");
    expect(eng2.get(id)!.nextRun).toBe(L(2026, 11, 21, 9));
    release();
    await eng.idle();
  });

  it("到了结束时间自动结束；删除", async () => {
    const clock = { t: L(2026, 11, 18, 8) };
    const { eng } = mk(async () => ({ status: "done", text: "" }), clock);
    const id = eng.saveItem({ ...base, endAt: L(2026, 11, 19, 12) }).id!;
    clock.t = L(2026, 11, 19, 13);
    eng.tick();
    expect(statusOf(eng.get(id)!)).toBe("ended");
    expect(eng.remove(id)).toBe(true);
    expect(eng.remove(id)).toBe(false);
  });
});
