import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractTodos, fetchDingtalkTodos, fetchFeishuTodos, findList, sortTodos, toMs } from "../src/tools/workbench";

const NOW = Date.parse("2026-11-17T10:00:00+08:00");

describe("workbench 解析", () => {
  it("toMs：秒 / 毫秒 / 字符串 / 日期", () => {
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toMs("1700000000000")).toBe(1_700_000_000_000);
    expect(toMs("2026-11-20T18:00:00+08:00")).toBe(Date.parse("2026-11-20T18:00:00+08:00"));
    expect(toMs("")).toBeUndefined();
    expect(toMs("abc")).toBeUndefined();
  });

  it("飞书项目 mywork todo：list[].work_item_info", () => {
    const j = {
      total: 2,
      list: [
        { work_item_info: { work_item_id: 11, work_item_name: "修复登录", work_item_type_key: "story" }, state_info: { end_state_key_name: "开发中" } },
        { work_item_info: { work_item_id: 12, work_item_name: "优化首页" } },
      ],
    };
    const r = extractTodos(j, "feishu", NOW);
    expect(r.map(x => [x.id, x.title, x.sub])).toEqual([
      ["11", "修复登录", "开发中"],
      ["12", "优化首页", undefined],
    ]);
  });

  it("钉钉待办：嵌套在 result 里，字段 subject / dueTime / taskId", () => {
    const j = { success: true, result: { todoCards: [{ taskId: "t1", subject: "写周报", dueTime: NOW - 3600_000 }, { taskId: "t2", subject: "评审", dueTime: NOW + 86400_000 }, { taskId: "t3", subject: "无截止" }] } };
    const r = extractTodos(j, "dingtalk", NOW);
    expect(r.map(x => [x.id, x.title, !!x.overdue])).toEqual([
      ["t1", "写周报", true],
      ["t2", "评审", false],
      ["t3", "无截止", false],
    ]);
  });

  it("findList：纯数组、空、没有对象数组", () => {
    expect(findList([{ a: 1 }])).toHaveLength(1);
    expect(findList([])).toEqual([]);
    expect(findList({ a: [1, 2] })).toEqual([]);
    expect(findList(null)).toEqual([]);
  });

  it("过滤掉没有标题的；非 http 链接丢弃", () => {
    const r = extractTodos([{ id: 1 }, { id: 2, title: "ok", url: "javascript:alert(1)" }, { id: 3, title: "x", url: "https://a.b/c" }], "dingtalk", NOW);
    expect(r.map(x => [x.id, x.url])).toEqual([["2", undefined], ["3", "https://a.b/c"]]);
  });

  it("sortTodos：逾期 → 有截止（近的在前）→ 无截止", () => {
    const r = sortTodos([
      { id: "a", title: "a", source: "feishu" },
      { id: "b", title: "b", source: "feishu", due: NOW + 2 },
      { id: "c", title: "c", source: "feishu", due: NOW + 1 },
      { id: "d", title: "d", source: "feishu", due: NOW - 5, overdue: true },
    ]);
    expect(r.map(x => x.id)).toEqual(["d", "c", "b", "a"]);
  });
});

let script: string;
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-"));
  script = path.join(dir, "fake.cjs");
  fs.writeFileSync(
    script,
    `const a = process.argv.slice(2);
if (a.includes("--action=todo")) console.log(JSON.stringify({ list: [{ work_item_info: { work_item_id: 1, work_item_name: "A" } }, { work_item_info: { work_item_id: 2, work_item_name: "B" } }] }));
else if (a.includes("--action=overdue")) console.log(JSON.stringify({ list: [{ work_item_info: { work_item_id: 2, work_item_name: "B" } }, { work_item_info: { work_item_id: 3, work_item_name: "C" } }] }));
else if (a[0] === "todo") console.log(JSON.stringify({ result: { todoCards: [{ taskId: "x", subject: "钉钉任务" }] } }));
else { console.error("not logged in"); process.exit(2); }`,
  );
});

describe("workbench 拉取", () => {
  it("飞书：待办 + 逾期合并去重，逾期打标", async () => {
    const r = await fetchFeishuTodos({ bin: process.execPath, binArgs: [script] });
    expect(r.ok).toBe(true);
    expect(r.items.map(i => [i.id, !!i.overdue])).toEqual([["1", false], ["2", true], ["3", true]]);
  });

  it("飞书：工时排期补上不在待办里的需求，待办里没日期的补日期", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb2-"));
    const s = path.join(dir, "fake2.cjs");
    fs.writeFileSync(
      s,
      `const a = process.argv.slice(2);
const row = (id, n) => ({ work_item_info: { work_item_id: id, work_item_name: n }, project_key: "p1" });
if (a[0] === "user") console.log(JSON.stringify({ name_cn: "我", user_key: "u1" }));
else if (a[0] === "workhour") console.log(JSON.stringify({ user_workload_list: [{ tasks: [
  { work_item_info: { id: 1, name: "A" }, time: { start: "2026-11-04 00:00:00", end: "2026-11-05 23:59:59" }, state: { state_name: "技术排期" } },
  { work_item_info: { id: 9, name: "企微群" }, time: { start: "2026-11-04 00:00:00", end: "2026-11-04 23:59:59" }, state: { state_name: "技术排期" } },
] }] }));
else if (a.includes("--action=todo")) console.log(JSON.stringify({ list: [row(1, "A")] }));
else if (a.includes("--action=overdue")) console.log(JSON.stringify({ list: [] }));
else process.exit(2);`,
    );
    const r = await fetchFeishuTodos({ bin: process.execPath, binArgs: [s] });
    expect(r.ok).toBe(true);
    const a = r.items.find(i => i.id === "1")!;
    const n = r.items.find(i => i.id === "9")!;
    expect(a.start).toBe(new Date(2026, 10, 4).getTime());
    expect(n.title).toBe("企微群");
    expect(n.node).toBe("技术排期");
    expect(n.projectKey).toBe("p1");
    expect(n.start).toBe(new Date(2026, 10, 4).getTime());
  });

  it("钉钉：读取未完成待办", async () => {
    const r = await fetchDingtalkTodos({ bin: process.execPath, binArgs: [script] });
    expect(r.items.map(i => i.title)).toEqual(["钉钉任务"]);
  });

  it("CLI 报错或不存在：ok=false 并带原因", async () => {
    const missing = await fetchDingtalkTodos({ bin: "definitely-not-a-real-binary-xyz" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("启动");
  });
});
