import { describe, it, expect } from "vitest";
import { cursorAskTool } from "../src/models/cursor-sdk";
import { agentSafetyPrompt } from "../src/prompt/agent-safety";
import { runDelegate } from "../src/core/loop";
import type { AgentBackend, AskAnswer, AskQuestion, DelegateInput } from "../src/core/types";

const signal = new AbortController().signal;

describe("给 Cursor Agent 的 ask_user 自定义工具", () => {
  it("把问题转给操作人，回答整理成 JSON 返回", async () => {
    let got: AskQuestion[] = [];
    const tool = cursorAskTool(async qs => {
      got = qs;
      return [{ id: "q1", question: qs[0].question, picked: ["不处理"], text: "先别动" } satisfies AskAnswer];
    }, signal);
    const out = JSON.parse(await tool.execute({ questions: [{ question: "master 被占用，怎么办？", options: ["把占用方脱离", "不处理", "不处理"], multiple: false }] }));
    expect(got).toHaveLength(1);
    expect(got[0].options).toEqual(["把占用方脱离", "不处理"]); // 选项去重
    expect(got[0].allowText).toBe(true);
    expect(out.answered).toBe(true);
    expect(out.answers[0].answer).toBe("不处理；先别动");
  });
  it("操作人跳过：返回 answered=false，让 Agent 自己做假设并说明", async () => {
    const tool = cursorAskTool(async () => null, signal);
    const out = JSON.parse(await tool.execute({ questions: [{ question: "选哪个？" }] }));
    expect(out.answered).toBe(false);
    expect(out.note).toContain("假设");
  });
  it("参数不对（没有 questions / 全是空问题）：不打扰操作人，提示 Agent 重试", async () => {
    let asked = false;
    const tool = cursorAskTool(async () => ((asked = true), null), signal);
    expect(JSON.parse(await tool.execute({})).answered).toBe(false);
    expect(JSON.parse(await tool.execute({ questions: [{ question: "  " }, 3, null] })).answered).toBe(false);
    expect(asked).toBe(false);
  });
  it("工具带描述和 JSON Schema（Agent 才知道怎么调）", () => {
    const tool = cursorAskTool(async () => null, signal);
    expect(tool.description).toContain("向操作人提问");
    expect((tool.inputSchema as any).required).toEqual(["questions"]);
  });
});

describe("外部 Agent 的操作边界提示", () => {
  it("写明工作区、危险操作清单和「被占用不要绕过去」", () => {
    const p = agentSafetyPrompt("E:/repo", false);
    expect(p).toContain("E:/repo");
    for (const k of ["checkout", "reset --hard", "worktree", "被占用"]) expect(p).toContain(k);
  });
  it("有人可问时叫它用 ask_user；没人时叫它在回复里说明、不要自己挑", () => {
    expect(agentSafetyPrompt("x", true)).toContain("ask_user");
    expect(agentSafetyPrompt("x", false)).not.toContain("ask_user");
    expect(agentSafetyPrompt("x", false)).toContain("不要自己挑一个做");
  });
});

describe("runDelegate 把提问通道交给后端", () => {
  it("有 ask 就传给 backend.run，没有就不传", async () => {
    const seen: Array<DelegateInput["ask"]> = [];
    const backend: AgentBackend = { id: "fake", run: async i => (seen.push(i.ask), { text: "ok" }) };
    const base = { backend, emit: () => {}, signal, input: "hi", root: process.cwd(), tools: [], system: "", guard: undefined as any, approve: async () => false, context: undefined as any, runId: "r" } as any;
    const ask = async () => null;
    await runDelegate({ ...base, ask });
    await runDelegate({ ...base });
    expect(seen[0]).toBe(ask);
    expect(seen[1]).toBeUndefined();
  });
});
