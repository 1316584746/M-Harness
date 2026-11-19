import { describe, expect, it } from "vitest";
import { buildRunView } from "../desktop/renderer/src/lib/steps";

const p = (line: string, kind?: string) => ({ type: "agent_progress", line, ...(kind ? { kind } : {}) }) as any;

describe("buildRunView：外部 Agent（Cursor / 命令行）的统计", () => {
  it("没有模型步数，但能数出工具调用，并标记为外部", () => {
    const v = buildRunView([p("先看一下", "text"), p('🔧 shell {"command":"ls"}', "tool"), p("   ✓ shell → ok", "tool"), p("🔧 read_file {}", "tool"), p("   ✗ read_file 失败：x", "tool"), p("答案", "text")]);
    expect(v.external).toBe(true);
    expect(v.steps).toHaveLength(0);
    expect(v.toolCount).toBe(2);
  });
  it("给了时间戳就算出耗时", () => {
    const v = buildRunView([p("a"), p("b")], [1000, 1500, 4000]);
    expect(v.totalMs).toBe(3000);
  });
  it("内置模型的运行不受影响（不是外部）", () => {
    const v = buildRunView([{ type: "run_start", provider: "x", input: "hi" } as any, { type: "model_call", step: 1 } as any]);
    expect(v.external).toBeUndefined();
    expect(v.steps).toHaveLength(1);
  });
});
