import { describe, expect, it } from "vitest";
import { newToolCalls, wrapUpPrompt } from "../src/models/cursor-sdk";
import { toolBudgetFor } from "../desktop/renderer/src/lib/budget";

describe("newToolCalls：探索预算按「次」数，不按消息条数", () => {
  it("同一次调用的 running / completed 只算 1 次", () => {
    const calls = new Set<string>();
    expect(newToolCalls({ type: "tool_call", call_id: "a", status: "running" }, calls)).toBe(1);
    expect(newToolCalls({ type: "tool_call", call_id: "a", status: "completed" }, calls)).toBe(0);
    expect(calls.size).toBe(1);
  });
  it("assistant 里的 tool_use 也算，并且和 tool_call 用同一个 id 不重复计", () => {
    const calls = new Set<string>();
    expect(newToolCalls({ type: "assistant", message: { content: [{ type: "text", text: "x" }, { type: "tool_use", id: "b", name: "read" }, { type: "tool_use", id: "c", name: "grep" }] } }, calls)).toBe(2);
    expect(newToolCalls({ type: "tool_call", call_id: "b", status: "completed" }, calls)).toBe(0);
    expect(calls.size).toBe(2);
  });
  it("思考 / 文字 / 没有 id 的消息不算", () => {
    const calls = new Set<string>();
    expect(newToolCalls({ type: "thinking", text: "..." }, calls)).toBe(0);
    expect(newToolCalls({ type: "tool_call", status: "running" }, calls)).toBe(0);
    expect(newToolCalls(undefined, calls)).toBe(0);
    expect(calls.size).toBe(0);
  });
});

describe("预算只给只读步骤", () => {
  it("分析 / 方案 / CR / 上线检查有，开发 / 联调 / 提测 / 自定义 / 自由对话没有", () => {
    for (const id of ["analysis", "plan", "review", "release"]) expect(toolBudgetFor(id)).toBeGreaterThan(0);
    for (const id of ["build", "dev", "ship", "my-custom", undefined]) expect(toolBudgetFor(id)).toBeUndefined();
  });
  it("收尾指令写明次数并禁止再调工具", () => {
    const s = wrapUpPrompt(50);
    expect(s).toContain("50");
    expect(s).toContain("不能再调用任何工具");
  });
});
