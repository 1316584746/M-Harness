import { describe, expect, it } from "vitest";
import { isNominal } from "../desktop/shared/schedule";

describe("isNominal：只是挂名负责人的需求不算我的排期", () => {
  it("飞书需求：没有排期、名下没有子任务 → 挂名", () => {
    expect(isNominal({ source: "feishu" })).toBe(true);
    // 只有节点（我是节点负责人），没有子任务、没有日期
    expect(isNominal({ source: "feishu", children: [{ kind: "node" }] })).toBe(true);
  });
  it("有我的子任务（哪怕没排日期）→ 不是挂名", () => {
    expect(isNominal({ source: "feishu", children: [{ kind: "node" }, { kind: "subtask" }] })).toBe(false);
  });
  it("有排期（节点有起止日期）→ 不是挂名", () => {
    expect(isNominal({ source: "feishu", start: 1, end: 2, children: [{ kind: "node" }] })).toBe(false);
    expect(isNominal({ source: "feishu", end: 2 })).toBe(false);
  });
  it("钉钉待办本来就可以没有日期 → 不算", () => {
    expect(isNominal({ source: "dingtalk" })).toBe(false);
  });
});
