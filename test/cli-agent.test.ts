import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/core/loop";
import type { HarnessEvent } from "../src/core/types";
import { cliAgent } from "../src/models/cli-agent";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli agent-")); // 路径里故意带空格
const script = path.join(dir, "fake-agent.mjs");
fs.writeFileSync(
  script,
  `let s = ""; process.stdin.on("data", d => s += d);
   process.stdin.on("end", () => { console.error("working..."); console.log("AGENT:" + s.trim().split("\\n").pop()); });`,
);

describe("CLI Agent 委托后端", () => {
  it("stdin 传提示词，stdout 作为结果，stderr 作为过程进度", async () => {
    const events: HarnessEvent[] = [];
    const r = await run({
      provider: { kind: "agent", id: "fake", backend: cliAgent({ id: "fake", command: process.execPath, args: [script], promptVia: "stdin" }) },
      tools: [],
      system: "",
      input: "修复登录 bug",
      root: dir,
      emit: e => events.push(e),
    });
    expect(r.reason).toBe("final");
    expect(r.text).toBe("AGENT:修复登录 bug");
    expect(events.some(e => e.type === "agent_progress" && e.line.includes("working"))).toBe(true);
    expect(r.messages.map(m => m.role)).toEqual(["user", "assistant"]);
  });

  it("命令不存在时返回 error，不抛异常", async () => {
    const r = await run({
      provider: { kind: "agent", id: "x", backend: cliAgent({ id: "x", command: "definitely-not-a-real-cmd-xyz", args: [], promptVia: "stdin" }) },
      tools: [],
      system: "",
      input: "hi",
      root: dir,
    });
    expect(r.reason).toBe("error");
  });

  it("可中断", async () => {
    const ac = new AbortController();
    const sleeper = path.join(dir, "sleep.mjs");
    fs.writeFileSync(sleeper, "setTimeout(() => {}, 60000);");
    const p = run({
      provider: { kind: "agent", id: "s", backend: cliAgent({ id: "s", command: process.execPath, args: [sleeper], promptVia: "stdin" }) },
      tools: [],
      system: "",
      input: "hi",
      root: dir,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 300);
    const r = await p;
    expect(r.reason).toBe("aborted");
  });

  it("「准备中」阶段点停止：backend 完全不理会 signal，也要立刻返回 aborted", async () => {
    const ac = new AbortController();
    const events: HarnessEvent[] = [];
    let settle: ((v: { text: string }) => void) | undefined;
    // 模拟 Cursor SDK 创建 Agent / 提交任务阶段：既不响应 signal、也迟迟不返回
    const stuck = { id: "stuck", run: () => new Promise<{ text: string }>(res => (settle = res)) };
    const t0 = Date.now();
    const p = run({ provider: { kind: "agent", id: "stuck", backend: stuck }, tools: [], system: "", input: "hi", root: dir, signal: ac.signal, emit: e => events.push(e) });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.reason).toBe("aborted");
    expect(r.error).toBe("已中断");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "aborted" });
    settle?.({ text: "迟到的结果" }); // 之后 backend 才结束，不应有任何影响
  });

  it("开始前就已经中断 / backend 在中断后才报错：都按 aborted 处理，不会变成未处理异常", async () => {
    const pre = new AbortController();
    pre.abort();
    const never = { id: "n", run: () => new Promise<{ text: string }>(() => {}) };
    expect((await run({ provider: { kind: "agent", id: "n", backend: never }, tools: [], system: "", input: "hi", root: dir, signal: pre.signal })).reason).toBe("aborted");

    const ac = new AbortController();
    const lateFail = { id: "l", run: () => new Promise<{ text: string }>((_, rej) => setTimeout(() => rej(new Error("boom")), 300)) };
    const p = run({ provider: { kind: "agent", id: "l", backend: lateFail }, tools: [], system: "", input: "hi", root: dir, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    expect((await p).reason).toBe("aborted");
    await new Promise(r => setTimeout(r, 400)); // 等 backend 的失败发生；vitest 会把未处理异常当作失败
  });
});
