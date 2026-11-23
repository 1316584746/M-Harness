import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addChild } from "../desktop/shared/todoPatch";
import type { TodoItemDTO } from "../desktop/shared/api";
import { createFeishuSubtask } from "../src/tools/workbench";

/** 假的 meegle：subtask update --action=create 把新子任务记进 state.json，get-node 读回来；mode 控制「接受 / 静默忽略 / 报错」 */
let dir: string;
let script: string;
const cfg = () => ({ bin: process.execPath, binArgs: [script] });
const mode = (m: string) => fs.writeFileSync(path.join(dir, "mode"), m);
const calls = () => fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").map(l => JSON.parse(l) as string[]);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-create-"));
  script = path.join(dir, "fake.cjs");
  fs.writeFileSync(
    script,
    `const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const f = path.join(__dirname, "state.json");
const m = fs.existsSync(path.join(__dirname, "mode")) ? fs.readFileSync(path.join(__dirname, "mode"), "utf8") : "ok";
const st = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { created: [] };
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(a) + "\\n");
if (a[0] === "user") console.log(JSON.stringify({ name_cn: "我", user_key: "u1" }));
else if (a[0] === "workflow") console.log(JSON.stringify({ list: [{ basic: { name: "排期", node_key: "jishu" }, sub_tasks: [{ sub_task_id: "1", sub_task_name: "旧的", owner: "[]" }, ...st.created] }], pagination: { has_more: false } }));
else if (a[0] === "subtask") {
  if (m === "fail") { console.error("no permission"); process.exit(1); }
  const p = JSON.parse(a[a.indexOf("-P") + 1]);
  if (m === "ok") { st.created.push({ sub_task_id: "n" + (st.created.length + 1), sub_task_name: p.fields[0].field_value, owner: "[]" }); fs.writeFileSync(f, JSON.stringify(st)); }
  console.log("{}");
}`,
  );
});

describe("createFeishuSubtask", () => {
  it("建成功：带名称 / 节点 / 当前账号为负责人，读回新子任务", async () => {
    mode("ok");
    const r = await createFeishuSubtask(cfg(), { projectKey: "p1", wid: "7", nodeKey: "jishu", name: "  写接口  " });
    expect(r.ok).toBe(true);
    expect(r.child).toMatchObject({ title: "写接口", kind: "subtask", nodeKey: "jishu", parent: "排期", owner: "我" });
    const p = JSON.parse(calls().find(c => c[0] === "subtask")![calls().find(c => c[0] === "subtask")!.indexOf("-P") + 1]);
    expect(p).toMatchObject({ action: "create", node_id: "jishu", project_key: "p1", work_item_id: "7", assignee: ["u1"], fields: [{ field_key: "name", field_value: "写接口" }] });
  });

  it("飞书静默忽略（读回来没有新子任务）：报错，不假装成功", async () => {
    mode("ignore");
    const r = await createFeishuSubtask(cfg(), { projectKey: "p1", wid: "7", nodeKey: "jishu", name: "不会出现" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("没在需求里读到");
  });

  it("命令报错：把原因交回来", async () => {
    mode("fail");
    const r = await createFeishuSubtask(cfg(), { projectKey: "p1", wid: "7", nodeKey: "jishu", name: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no permission");
  });

  it("名称为空 / 定位信息不对：不调用命令", async () => {
    mode("ok");
    const before = calls().length;
    expect((await createFeishuSubtask(cfg(), { projectKey: "p1", wid: "7", nodeKey: "jishu", name: "   " })).ok).toBe(false);
    expect((await createFeishuSubtask(cfg(), { projectKey: "p1", wid: "7", nodeKey: "a b;rm", name: "x" })).ok).toBe(false);
    expect(calls().length).toBe(before);
  });
});

describe("addChild", () => {
  const item = (id: string, children: TodoItemDTO["children"]) => ({ id, title: id, source: "feishu", children }) as TodoItemDTO;
  it("只加到对应需求，重复的不再加，新子任务带日期时需求起止重新算", () => {
    const items = [item("1", []), item("2", [])];
    const c = { id: "s1", title: "新", kind: "subtask" as const, start: 100, end: 200 };
    const a = addChild(items, "1", c);
    expect(a[0].children).toHaveLength(1);
    expect(a[0]).toMatchObject({ start: 100, end: 200, due: 200 });
    expect(a[1].children).toHaveLength(0);
    expect(addChild(a, "1", c)[0].children).toHaveLength(1);
  });
});
