import { describe, expect, it } from "vitest";
import { feishuRows, groupFeishu, type SubInfo } from "../src/tools/workbench";

const row = (wid: number, name: string, o: { node?: string; sub?: number; s?: string; e?: string } = {}) => ({
  work_item_info: { work_item_id: wid, work_item_name: name, work_item_type_key: "story" },
  project_key: "p",
  project_name: "空间",
  node_info: { node_name: o.node ?? "", node_state_key: o.node ? `n_${wid}_${o.node}` : "x" },
  ...(o.sub ? { sub_task_info: { id: o.sub, name: "" } } : {}),
  schedule: { start_time: o.s ?? "", end_time: o.e ?? "" },
});

describe("飞书待办按需求聚合", () => {
  const all = feishuRows({
    list: [
      row(1, "需求甲", { node: "技术方案评审" }),
      row(1, "需求甲", { sub: 11, s: "2026-11-10", e: "2026-11-12" }),
      row(1, "需求甲", { sub: 12, s: "2026-11-15", e: "2026-11-16" }),
      row(2, "需求乙", { sub: 21 }),
      row(2, "需求乙", { sub: 22 }),
      row(3, "需求丙", { node: "技术开发联调" }),
    ],
  });
  const active = feishuRows({ list: [row(1, "需求甲", { node: "技术方案评审" }), row(3, "需求丙", { node: "技术开发联调" })] });
  const subs = new Map<string, SubInfo>([
    ["11", { name: "接口设计", parent: "技术排期" }],
    ["12", { name: "联调", parent: "技术排期", done: true }],
    ["21", { name: "写用例", parent: "测试排期" }],
  ]);
  const r = groupFeishu(all, active, [], subs);
  const by = (id: string) => r.find(x => x.id === id)!;

  it("同一个需求只出一条，我的节点和子任务都挂在它下面", () => {
    expect(r.map(x => x.id)).toEqual(["1", "2", "3"]);
    expect(by("1").children?.map(c => [c.kind, c.title])).toEqual([
      ["node", "技术方案评审"],
      ["subtask", "接口设计"],
      ["subtask", "联调"],
    ]);
    expect(by("1").children?.find(c => c.title === "联调")?.done).toBe(true);
  });

  it("需求的起止日期取子项日期的并集", () => {
    const a = by("1");
    expect(new Date(a.start!).getDate()).toBe(10);
    expect(new Date(a.end!).getDate()).toBe(16);
    expect(by("2").start).toBeUndefined();
  });

  it("在 in_progress 里有行的需求才算进行中；名字取不到的子任务叫「任务」", () => {
    expect(r.filter(x => x.active).map(x => x.id)).toEqual(["1", "3"]);
    expect(by("1").children?.find(c => c.kind === "node")?.active).toBe(true);
    expect(by("2").children?.map(c => c.title)).toEqual(["写用例", "任务"]);
    expect(by("2").active).toBeUndefined();
  });

  it("逾期按需求标记", () => {
    const o = groupFeishu(all, active, feishuRows({ list: [row(2, "需求乙", { sub: 21 })] }), subs);
    expect(o.find(x => x.id === "2")?.overdue).toBe(true);
    expect(o.find(x => x.id === "1")?.overdue).toBeUndefined();
  });

  it("我名下已做完的子任务（mywork 里没有）也列出来，带人天和负责人；别人的不要", () => {
    const withDone = new Map(subs);
    withDone.set("13", { name: "已做完", wid: "1", parent: "技术排期", done: true, days: 2, owners: ["me"], start: Date.UTC(2026, 10, 13) });
    withDone.set("14", { name: "别人的", wid: "1", parent: "技术排期", owners: ["other"] });
    const o = groupFeishu(all, active, [], withDone, { key: "me", name: "我" });
    const kids = o.find(x => x.id === "1")!.children!.filter(c => c.kind === "subtask");
    expect(kids.map(c => c.title)).toContain("已做完");
    expect(kids.map(c => c.title)).not.toContain("别人的");
    const done = kids.find(c => c.title === "已做完")!;
    expect([done.done, done.days, done.owner]).toEqual([true, 2, "我"]);
  });
});
