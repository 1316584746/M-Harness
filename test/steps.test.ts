import { describe, expect, it } from "vitest";
import { argSummary, buildRunView, fmtMs } from "../desktop/renderer/src/lib/steps";
import type { HarnessEvent } from "../src/core/types";

const reply = (step: number, content: string, tools: string[] = [], ms = 100, tokens = 10): HarnessEvent => ({
  type: "model_reply",
  step,
  ms,
  tokens,
  reply: { message: { role: "assistant", content }, toolCalls: tools.map((name, i) => ({ id: `c${i}`, name, args: {} })) },
});

describe("事件流 → 步骤视图", () => {
  it("把工具调用归到对应步骤，并汇总 token / 工具数", () => {
    const events: HarnessEvent[] = [
      { type: "run_start", runId: "r", provider: "deepseek", input: "读一下 a.txt" },
      { type: "model_call", step: 1, messages: [] },
      reply(1, "我来读文件", ["read_file"]),
      { type: "tool_call", step: 1, name: "read_file", args: { path: "a.txt" } },
      { type: "tool_result", step: 1, name: "read_file", output: "内容", ms: 5 },
      { type: "model_call", step: 2, messages: [] },
      reply(2, "文件内容是……"),
      { type: "done", reason: "final", text: "文件内容是……" },
    ];
    const v = buildRunView(events);
    expect(v.provider).toBe("deepseek");
    expect(v.steps.map(s => s.n)).toEqual([1, 2]);
    expect(v.steps[0].text).toBe("我来读文件");
    expect(v.steps[0].tools[0]).toMatchObject({ name: "read_file", status: "ok", output: "内容", ms: 5 });
    expect(v.steps[1].tools).toEqual([]);
    expect(v.toolCount).toBe(1);
    expect(v.tokens).toBe(20);
    expect(v.totalMs).toBe(205);
    expect(v.done?.reason).toBe("final");
    expect(v.activity).toBeUndefined();
  });

  it("审批通过 / 拒绝 / 被护栏拦截 三种状态区分清楚", () => {
    const v = buildRunView([
      { type: "approval", step: 1, name: "write_file", args: {}, approved: true },
      { type: "tool_call", step: 1, name: "write_file", args: { path: "a" } },
      { type: "tool_result", step: 1, name: "write_file", output: "ok", ms: 1 },
      { type: "approval", step: 2, name: "run_command", args: {}, approved: false },
      { type: "tool_blocked", step: 2, name: "run_command", reason: "审批未通过" },
      { type: "tool_blocked", step: 3, name: "run_command", reason: "命令命中危险规则" },
    ]);
    expect(v.steps[0].tools[0]).toMatchObject({ status: "ok", approved: true });
    expect(v.steps[1].tools[0]).toMatchObject({ status: "denied", approved: false });
    expect(v.steps[2].tools[0]).toMatchObject({ status: "blocked", reason: "命令命中危险规则" });
  });

  it("同名工具连续调用时，结果对应到最近一个未完成的调用", () => {
    const v = buildRunView([
      { type: "tool_call", step: 1, name: "read_file", args: { path: "a" } },
      { type: "tool_call", step: 1, name: "read_file", args: { path: "b" } },
      { type: "tool_result", step: 1, name: "read_file", output: "B", ms: 1 },
      { type: "tool_result", step: 1, name: "read_file", output: "A?", ms: 1 },
    ]);
    expect(v.steps[0].tools.map(t => t.output)).toEqual(["A?", "B"]);
  });

  it("外部 Agent 的进度行与上下文压缩提示", () => {
    const v = buildRunView([
      { type: "agent_progress", line: "reading files" },
      { type: "context_trim", before: 900, after: 400, dropped: 6 },
    ]);
    expect(v.progress).toEqual(["reading files"]);
    expect(v.notes[0]).toContain("900 → 400");
  });

  it("有时间戳时用首尾差作为总耗时", () => {
    expect(buildRunView([{ type: "done", reason: "final" }], [1000, 1800, 2500]).totalMs).toBe(1500);
  });

  it("格式化辅助函数", () => {
    expect(fmtMs(850)).toBe("850ms");
    expect(fmtMs(1234)).toBe("1.2s");
    expect(fmtMs(25_000)).toBe("25s");
    expect(argSummary("run_command", { command: "ls" })).toBe("ls");
    expect(argSummary("read_file", { path: "a.txt", offset: 2 })).toBe("a.txt");
    expect(argSummary("x", {})).toBe("");
  });
});
