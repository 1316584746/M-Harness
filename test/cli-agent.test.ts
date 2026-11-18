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
});
