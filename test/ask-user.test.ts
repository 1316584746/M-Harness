import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Backend } from "../desktop/main/backend";
import { run } from "../src/core/loop";
import type { AskAnswer, AskQuestion, HarnessEvent, ModelReply } from "../src/core/types";
import { askUserTool } from "../src/tools/ask-user";
import { scriptedModel } from "./helpers/echo-llm";

const call = (name: string, args: unknown): ModelReply => ({ message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name, args }] });
const say = (content: string): ModelReply => ({ message: { role: "assistant", content } });
const QS = { questions: [{ question: "用哪个库？", options: ["A 库", "B 库"] }, { question: "还有别的要求吗？" }] };

async function go(ask?: (qs: AskQuestion[]) => Promise<AskAnswer[] | null>) {
  const events: HarnessEvent[] = [];
  const result = await run({
    provider: { kind: "model", id: "t", adapter: scriptedModel([call("ask_user", QS), say("好的")]) },
    tools: [askUserTool],
    system: "t",
    input: "go",
    root: os.tmpdir(),
    emit: e => events.push(e),
    ask: ask ? qs => ask(qs) : undefined,
  });
  const tool = result.messages.find(m => m.role === "tool")!.content;
  return { result, events, out: JSON.parse(tool) };
}

describe("ask_user 工具", () => {
  it("问题编号、选项去重；操作人的选择和自己写的回答一起回给模型", async () => {
    let seen: AskQuestion[] = [];
    const { out, result } = await go(async qs => {
      seen = qs;
      return [
        { id: "q1", question: "用哪个库？", picked: ["B 库"] },
        { id: "q2", question: "还有别的要求吗？", picked: [], text: "不要新增依赖" },
      ];
    });
    expect(seen.map(q => q.id)).toEqual(["q1", "q2"]);
    expect(seen[0]).toMatchObject({ options: ["A 库", "B 库"], allowText: true });
    expect(seen[1].options).toBeUndefined();
    expect(out.answered).toBe(true);
    expect(out.answers).toEqual([
      { question: "用哪个库？", picked: ["B 库"], answer: "B 库" },
      { question: "还有别的要求吗？", picked: [], text: "不要新增依赖", answer: "不要新增依赖" },
    ]);
    expect(result.reason).toBe("final");
  });

  it("操作人跳过：告诉模型自己做假设", async () => {
    const { out } = await go(async () => null);
    expect(out.answered).toBe(false);
    expect(out.note).toContain("假设");
  });

  it("没有提问通道（命令行 / 通道 / 自动化）：不卡住，直接告诉模型", async () => {
    const { out } = await go(undefined);
    expect(out.answered).toBe(false);
  });

  it("参数不合法（没有问题 / 问题太多）被拒绝", () => {
    expect(askUserTool.schema.safeParse({ questions: [] }).success).toBe(false);
    expect(askUserTool.schema.safeParse({ questions: Array.from({ length: 7 }, () => ({ question: "x" })) }).success).toBe(false);
  });
});

describe("后台：提问和回答", () => {
  let home: string;
  let sent: Array<[string, any]>;
  let b: Backend;
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ask-home-"));
    sent = [];
    b = new Backend(home, { send: (ch: string, p: unknown) => void sent.push([ch, p]) } as never);
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
  const ask = (qs: AskQuestion[], sig = new AbortController().signal) => (b as any).askUser("run1", qs, sig) as Promise<AskAnswer[] | null>;
  const Q: AskQuestion[] = [
    { id: "q1", question: "单选", options: ["x", "y"] },
    { id: "q2", question: "多选", options: ["a", "b", "c"], multiple: true },
    { id: "q3", question: "只能选", options: ["m"], allowText: false },
  ];

  it("发给界面、按问过的问题收回答；多余的选项和不允许的文字被丢掉", async () => {
    const p = ask(Q);
    const req = sent.at(-1)!;
    expect(req[0]).toBe("ask:request");
    expect(req[1]).toMatchObject({ runKey: "run1", questions: Q });
    b.respondAsk(req[1].id, [
      { id: "q1", picked: ["x", "y", "不存在"], text: "  自己写的  " },
      { id: "q2", picked: ["a", "c"] },
      { id: "q3", picked: ["m"], text: "不该有" },
      { id: "zzz", picked: ["x"] },
    ]);
    expect(await p).toEqual([
      { id: "q1", question: "单选", picked: ["x"], text: "自己写的" },
      { id: "q2", question: "多选", picked: ["a", "c"] },
      { id: "q3", question: "只能选", picked: ["m"] },
    ]);
  });

  it("跳过 = null；运行被停止 = null；重复回答无效", async () => {
    const p1 = ask(Q);
    const id1 = sent.at(-1)![1].id;
    b.respondAsk(id1, null);
    expect(await p1).toBeNull();
    b.respondAsk(id1, []); // 已经结束，不会出事

    const ac = new AbortController();
    const p2 = ask(Q, ac.signal);
    ac.abort();
    expect(await p2).toBeNull();

    const p3 = ask(Q);
    b.abort("run1");
    expect(await p3).toBeNull();
  });
});
