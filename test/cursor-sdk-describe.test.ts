import { describe, expect, it } from "vitest";
import { describeMessage } from "../src/models/cursor-sdk";

describe("describeMessage：工具调用要带上参数", () => {
  it("只来了 completed 也会先补一行「🔧 名字 参数」，界面才知道读了哪个文件", () => {
    const seen = new Set<string>();
    const out = describeMessage({ type: "tool_call", call_id: "c1", name: "read", status: "completed", args: { path: "a/B.java" }, result: "ok" }, seen);
    expect(out.map(x => x[0])).toEqual(['🔧 read {"path":"a/B.java"}', "   ✓ read → ok"]);
  });

  it("running 先发过的，completed 不再重复发起行", () => {
    const seen = new Set<string>();
    const a = describeMessage({ type: "tool_call", call_id: "c2", name: "grep", status: "running", args: { pattern: "x" } }, seen);
    const b = describeMessage({ type: "tool_call", call_id: "c2", name: "grep", status: "completed", args: { pattern: "x" }, result: "3 matches" }, seen);
    expect(a.map(x => x[0])).toEqual(['🔧 grep {"pattern":"x"}']);
    expect(b.map(x => x[0])).toEqual(["   ✓ grep → 3 matches"]);
  });

  it("assistant 里的 tool_use 发过的，后面的 tool_call 不再重复", () => {
    const seen = new Set<string>();
    describeMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "c3", name: "shell", input: { command: "ls" } }] } }, seen);
    const out = describeMessage({ type: "tool_call", call_id: "c3", name: "shell", status: "completed", args: { command: "ls" }, result: "a" }, seen);
    expect(out.map(x => x[0])).toEqual(["   ✓ shell → a"]);
  });

  it("没有 seen 时（旧调用方式）行为不崩", () => {
    expect(describeMessage({ type: "tool_call", name: "shell", status: "error", result: "boom" }).map(x => x[1])).toEqual(["error"]);
  });
});
