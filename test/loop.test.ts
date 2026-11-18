import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Guardrails, approveAll } from "../src/core/guardrails";
import { ContextManager } from "../src/core/context";
import { run } from "../src/core/loop";
import type { HarnessEvent, ModelReply } from "../src/core/types";
import { scriptedModel } from "./helpers/echo-llm";
import { builtinTools } from "../src/tools/builtin";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
const call = (name: string, args: unknown, id = "c1"): ModelReply => ({
  message: { role: "assistant", content: "" },
  toolCalls: [{ id, name, args }],
});
const say = (content: string): ModelReply => ({ message: { role: "assistant", content } });

async function go(script: ModelReply[], extra: Partial<Parameters<typeof run>[0]> = {}) {
  const events: HarnessEvent[] = [];
  const root = extra.root ?? tmp();
  const result = await run({
    provider: { kind: "model", id: "t", adapter: scriptedModel(script) },
    tools: builtinTools,
    system: "test",
    input: "go",
    root,
    emit: e => events.push(e),
    ...extra,
  });
  return { result, events, root };
}

describe("agent loop", () => {
  it("无工具调用时直接返回最终回答", async () => {
    const { result } = await go([say("你好")]);
    expect(result).toMatchObject({ reason: "final", text: "你好", steps: 1 });
  });

  it("危险命令被护栏拦截，并把拒绝原因回填给模型", async () => {
    const { result, events } = await go(
      [call("run_command", { command: "rm -rf /" }), say("已放弃")],
      { guard: new Guardrails({ policy: { exec: "allow" } }), approve: approveAll },
    );
    expect(events.some(e => e.type === "tool_blocked")).toBe(true);
    expect(events.some(e => e.type === "tool_call")).toBe(false);
    const toolMsg = result.messages.find(m => m.role === "tool")!;
    expect(toolMsg.content).toContain("被护栏拒绝");
    expect(result.reason).toBe("final");
  });

  it("未知工具与参数错误都变成文本回填，不抛异常", async () => {
    const { result } = await go([
      call("no_such_tool", {}, "a"),
      call("read_file", { wrong: 1 }, "b"),
      say("ok"),
    ]);
    const tools = result.messages.filter(m => m.role === "tool").map(m => m.content);
    expect(tools[0]).toContain("未知工具");
    expect(tools[1]).toContain("参数错误");
    expect(result.reason).toBe("final");
  });

  it("写操作默认需要审批：拒绝时文件不会被写入", async () => {
    const root = tmp();
    const { events } = await go(
      [call("write_file", { path: "a.txt", content: "hi" }), say("done")],
      { root }, // 默认 approve = denyAll
    );
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(events.find(e => e.type === "approval")).toMatchObject({ approved: false });
  });

  it("审批通过后写入成功", async () => {
    const root = tmp();
    await go([call("write_file", { path: "sub/a.txt", content: "hi" }), say("done")], { root, approve: approveAll });
    expect(fs.readFileSync(path.join(root, "sub/a.txt"), "utf8")).toBe("hi");
  });

  it("路径越界被沙箱拒绝（工具异常回填给模型）", async () => {
    const { result } = await go(
      [call("read_file", { path: "../../../../Windows/win.ini" }), say("ok")],
      { guard: new Guardrails({ policy: { read: "allow" } }) },
    );
    expect(result.messages.find(m => m.role === "tool")!.content).toContain("路径越界");
  });

  it("超过最大步数", async () => {
    const loop = Array.from({ length: 5 }, (_, i) => call("list_dir", { path: "." }, `c${i}`));
    const { result } = await go(loop, { maxSteps: 3 });
    expect(result.reason).toBe("max_steps");
    expect(result.steps).toBe(3);
  });

  it("可中断", async () => {
    const ac = new AbortController();
    ac.abort();
    const { result } = await go([say("never")], { signal: ac.signal });
    expect(result.reason).toBe("aborted");
  });

  it("模型调用失败返回 error，不抛出", async () => {
    const { result } = await go([]); // 脚本为空 → 模型抛错
    expect(result.reason).toBe("error");
    expect(result.error).toContain("模型调用失败");
  });

  it("返回的 messages 可作为下一轮 history", async () => {
    const first = await go([say("第一轮")]);
    const second = await go([say("第二轮")], { history: first.result.messages, input: "继续" });
    expect(second.result.messages.map(m => m.content)).toEqual(["go", "第一轮", "继续", "第二轮"]);
  });

  it("工具输出超长会被截断", async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(50_000));
    const { result } = await go([call("read_file", { path: "big.txt" }), say("ok")], {
      root,
      context: new ContextManager({ maxTokens: 100_000, maxToolOutput: 1000 }),
    });
    const out = result.messages.find(m => m.role === "tool")!.content;
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain("已截断");
  });
});
