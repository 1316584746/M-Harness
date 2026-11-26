import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRetryable, sessionDel, sessionGet, sessionSet, sessionsResetMemory, RECONNECT_DELAYS } from "../src/models/cursor-sdk";

const dirs: string[] = [];
function tmpFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-sessions-"));
  dirs.push(d);
  return path.join(d, "sub", "cursor-sessions.json");
}
afterEach(() => {
  sessionsResetMemory();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上临时目录偶尔占用，不影响结论 */
    }
  }
});

describe("isRetryable：只有连接 / 服务端临时问题才值得原地重连", () => {
  it("网络、超时、SDK 的「反复续跑没进展」算可重试", () => {
    expect(isRetryable("Agent turn stopped after repeated resume attempts made no progress")).toBe(true);
    expect(isRetryable(new Error("SDK agent.send 超时（120s）— network deadline exceeded"))).toBe(true);
    expect(isRetryable("read ECONNRESET")).toBe(true);
    expect(isRetryable("fetch failed")).toBe(true);
    expect(isRetryable("503 Service Unavailable")).toBe(true);
  });
  it("鉴权、额度、用户中断、空消息不重试", () => {
    expect(isRetryable("401 Unauthorized: invalid api key")).toBe(false);
    expect(isRetryable("quota exceeded")).toBe(false);
    expect(isRetryable("已中断")).toBe(false);
    expect(isRetryable("The operation was aborted due to timeout")).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable("")).toBe(false);
  });
  it("重连次数有上限", () => {
    expect(RECONNECT_DELAYS.length).toBeGreaterThan(0);
    expect(RECONNECT_DELAYS.length).toBeLessThanOrEqual(5);
  });
});

describe("会话存档：软件重启后还能接回", () => {
  it("写入后清掉内存（模拟重启），仍能从文件读到", () => {
    const f = tmpFile();
    sessionSet("t1|m|/repo", "agent-1", f);
    sessionsResetMemory();
    expect(sessionGet("t1|m|/repo", f)).toBe("agent-1");
  });
  it("没给文件时只在内存里记，清掉就没了", () => {
    sessionSet("k", "agent-2");
    expect(sessionGet("k")).toBe("agent-2");
    sessionsResetMemory();
    expect(sessionGet("k")).toBeUndefined();
  });
  it("删除会同时清掉文件里的记录", () => {
    const f = tmpFile();
    sessionSet("k", "agent-3", f);
    sessionDel("k", f);
    sessionsResetMemory();
    expect(sessionGet("k", f)).toBeUndefined();
  });
  it("超过 7 天的存档不再接回，写入时顺手清掉", () => {
    const f = tmpFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ old: { id: "agent-old", at: Date.now() - 8 * 24 * 3600 * 1000 } }));
    expect(sessionGet("old", f)).toBeUndefined();
    sessionSet("new", "agent-new", f);
    expect(Object.keys(JSON.parse(fs.readFileSync(f, "utf8")))).toEqual(["new"]);
  });
  it("存档文件损坏时当作没有，不抛错", () => {
    const f = tmpFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "{坏了");
    expect(sessionGet("k", f)).toBeUndefined();
    sessionSet("k", "agent-4", f);
    sessionsResetMemory();
    expect(sessionGet("k", f)).toBe("agent-4");
  });
});
