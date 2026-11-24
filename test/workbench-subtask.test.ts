import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { patchChild } from "../desktop/shared/todoPatch";
import type { TodoItemDTO } from "../desktop/shared/api";
import { updateFeishuSubtask } from "../src/tools/workbench";

/** 假的 meegle：subtask update 把改动记进 state.json，get-node 读回来；mode 文件控制它「假装接受」还是「静默忽略」 */
let dir: string;
let script: string;
const cfg = () => ({ bin: process.execPath, binArgs: [script] });
const req = { projectKey: "p1", wid: "7", nodeKey: "jishu", subId: "101" };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-sub-"));
  script = path.join(dir, "fake.cjs");
  fs.writeFileSync(
    script,
    `const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const f = path.join(__dirname, "state.json");
const mode = fs.existsSync(path.join(__dirname, "mode")) ? fs.readFileSync(path.join(__dirname, "mode"), "utf8") : "ok";
const st = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
const g = k => (a.find(x => x.startsWith("--" + k + "=")) || "").slice(k.length + 3);
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(a) + "\\n");
if (a[0] === "subtask") {
  if (mode === "fail") { console.error("no permission"); process.exit(1); }
  if (mode === "ok") {
    const cur = st[g("task-id")] || {};
    if (g("action") === "confirm") cur.is_finished = true;
    if (g("action") === "rollback") cur.is_finished = false;
    if (g("action") === "update") { const s = JSON.parse(g("schedule")); if (s.estimate_start_date) { cur.estimate_start_date = String(s.estimate_start_date); cur.estimate_end_date = String(s.estimate_end_date); } if (s.points !== undefined) cur.points = s.points; }
    st[g("task-id")] = cur;
    fs.writeFileSync(f, JSON.stringify(st));
  }
  console.log("{}");
} else if (a[0] === "workflow") {
  console.log(JSON.stringify({ list: [{ basic: { name: "技术排期", node_key: "jishu" }, sub_tasks: [{ sub_task_id: "101", sub_task_name: "后端", estimate_start_date: "", estimate_end_date: "", is_finished: false, points: 1, owner: "[]", ...(st["101"] || {}) }] }], pagination: { has_more: false } }));
} else process.exit(2);
`,
  );
});

const set = (mode: string) => fs.writeFileSync(path.join(dir, "mode"), mode);
const reset = () => {
  for (const f of ["state.json", "calls.log"]) fs.rmSync(path.join(dir, f), { force: true });
};
const calls = () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").map(l => JSON.parse(l) as string[]) : []);
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe("updateFeishuSubtask 写飞书项目", () => {
  it("点圆完成：用 confirm，定位信息都带上，写完读回来是已完成", async () => {
    set("ok");
    reset();
    const r = await updateFeishuSubtask(cfg(), { ...req, done: true });
    expect(r).toMatchObject({ ok: true, child: { done: true } });
    const w = calls().find(c => c[0] === "subtask")!;
    expect(w).toEqual(expect.arrayContaining(["--action=confirm", "--node-id=jishu", "--project-key=p1", "--work-item-id=7", "--task-id=101"]));
  });

  it("再点一下：用 rollback，读回来是未完成", async () => {
    set("ok");
    reset();
    await updateFeishuSubtask(cfg(), { ...req, done: true });
    const r = await updateFeishuSubtask(cfg(), { ...req, done: false });
    expect(r).toMatchObject({ ok: true, child: { done: false } });
    expect(calls().filter(c => c[0] === "subtask").map(c => c[2])).toEqual(["--action=confirm", "--action=rollback"]);
  });

  it("改排期和人天：schedule 是 JSON（开始当天 0 点、结束当天最后一刻），读回来对得上", async () => {
    set("ok");
    reset();
    const r = await updateFeishuSubtask(cfg(), { ...req, start: day(2026, 11, 20), end: day(2026, 11, 21), days: 2 });
    expect(r.ok).toBe(true);
    expect(r.child?.days).toBe(2);
    const w = calls().find(c => c[0] === "subtask")!;
    const sch = JSON.parse(w.find(x => x.startsWith("--schedule="))!.slice(11));
    expect(sch).toEqual({ estimate_start_date: day(2026, 11, 20), estimate_end_date: day(2026, 11, 22) - 1, points: 2 });
    // 读回来的日期是同一天
    expect(new Date(r.child!.start!).getDate()).toBe(20);
    expect(new Date(r.child!.end!).getDate()).toBe(21);
  });

  it("只改人天：不带日期", async () => {
    set("ok");
    reset();
    const r = await updateFeishuSubtask(cfg(), { ...req, days: 3 });
    expect(r).toMatchObject({ ok: true, child: { days: 3 } });
    const sch = JSON.parse(calls().find(c => c[0] === "subtask")!.find(x => x.startsWith("--schedule="))!.slice(11));
    expect(sch).toEqual({ points: 3 });
  });

  it("命令失败：原样告诉用户原因，不假装成功", async () => {
    set("fail");
    reset();
    const r = await updateFeishuSubtask(cfg(), { ...req, done: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no permission");
    expect(r.child).toMatchObject({ done: false }); // 失败时也把飞书里的真实状态交给界面刷新
  });

  it("界面是旧的：想回滚，飞书里本来就没完成 → 当成成功，并刷新成真实状态", async () => {
    set("fail");
    reset();
    const r = await updateFeishuSubtask(cfg(), { ...req, done: false });
    expect(r).toMatchObject({ ok: true, child: { done: false } });
  });

  it("命令说成功但飞书没变：读回来对不上就报错，并给出飞书里真实的状态", async () => {
    set("ignore");
    reset();
    const r = await updateFeishuSubtask(cfg(), { ...req, done: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("飞书没有接受");
    expect(r.child?.done).toBe(false);
  });

  it("定位信息缺失或带怪字符：不执行任何命令", async () => {
    set("ok");
    reset();
    expect((await updateFeishuSubtask(cfg(), { ...req, nodeKey: "" , done: true })).ok).toBe(false);
    expect((await updateFeishuSubtask(cfg(), { ...req, subId: "1 --action=x", done: true })).ok).toBe(false);
    expect((await updateFeishuSubtask(cfg(), { ...req, start: Number.NaN, end: 1 })).ok).toBe(false);
    expect(calls()).toEqual([]);
  });

  it("什么都没要改：不执行命令", async () => {
    set("ok");
    reset();
    const r = await updateFeishuSubtask(cfg(), { ...req });
    expect(r.ok).toBe(false);
    expect(calls()).toEqual([]);
  });
});

describe("patchChild 把飞书读回来的值套到待办上", () => {
  const items: TodoItemDTO[] = [
    {
      id: "7",
      title: "需求",
      source: "feishu",
      start: 100,
      end: 200,
      children: [
        { id: "n", title: "技术排期", kind: "node", start: 100, end: 150 },
        { id: "101", title: "后端", kind: "subtask", start: 100, end: 200, done: false },
        { id: "102", title: "联调", kind: "subtask" },
      ],
    },
    { id: "8", title: "别的需求", source: "feishu", children: [{ id: "101", title: "同 id 的别家子任务", kind: "subtask" }] },
  ];

  it("只改命中的那个子任务，需求的起止日期按所有子项重新算", () => {
    const out = patchChild(items, "7", "102", { start: 300, end: 400, days: 2 });
    expect(out[0].children!.find(c => c.id === "102")).toMatchObject({ start: 300, end: 400, days: 2 });
    expect(out[0]).toMatchObject({ start: 100, end: 400, due: 400 });
    expect(out[1]).toBe(items[1]);
  });

  it("完成状态：只换 done，日期不动", () => {
    const out = patchChild(items, "7", "101", { done: true });
    expect(out[0].children!.find(c => c.id === "101")).toMatchObject({ done: true, start: 100, end: 200 });
    expect(out[0].start).toBe(100);
  });

  it("没命中就原样返回；节点不会被当成子任务改掉", () => {
    expect(patchChild(items, "9", "101", { done: true })).toEqual(items);
    expect(patchChild(items, "7", "n", { done: true })[0].children!.find(c => c.id === "n")!.done).toBeUndefined();
  });
});
