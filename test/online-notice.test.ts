import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { noticeText, parseUserOpenId, sendOnlineNotice, type Exec } from "../src/channels/online-notice";

const info = { version: "0.1.0", host: "WUKONG-PC", at: new Date(2026, 10, 23, 9, 5) };
const cfg = (over: Record<string, unknown> = {}) => parseConfig({ channels: { larkCli: { bin: "lark-cli", ...over } } }).channels.larkCli!;
const status = (openId?: string) => JSON.stringify({ appId: "cli_x", identities: { bot: { status: "ready" }, user: openId ? { status: "ok", openId } : { status: "none" } } }, null, 2);

function fake(authOut: string, sendCode = 0) {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const exec: Exec = async (args, stdin) => {
    calls.push({ args, stdin });
    if (args.includes("auth")) return { code: 0, stdout: authOut, stderr: "" };
    return { code: sendCode, stdout: "", stderr: sendCode ? "boom" : "" };
  };
  return { exec, calls };
}

describe("打开软件时的「已上线」提醒", () => {
  it("默认开：收件人是 lark-cli 里登录的人，用他自己的机器人（--as bot）发文字，正文走 stdin", async () => {
    const f = fake(status("ou_abc123"));
    const r = await sendOnlineNotice(cfg(), info, f.exec);
    expect(r).toEqual({ sent: true, to: "ou_abc123" });
    const send = f.calls.find(c => c.args.includes("+messages-send"))!;
    expect(send.args).toEqual(["im", "+messages-send", "--user-id", "ou_abc123", "--as", "bot", "--text", "-"]);
    expect(send.stdin).toContain("M-Harness 已上线");
    expect(send.stdin).toContain("WUKONG-PC");
    expect(send.stdin).toContain("2026-11-23 09:05");
    expect(send.stdin).toContain("0.1.0");
  });

  it("binArgs 放在子命令前面", async () => {
    const f = fake(status("ou_a"));
    await sendOnlineNotice(cfg({ binArgs: ["--profile", "p1"] }), info, f.exec);
    expect(f.calls.every(c => c.args[0] === "--profile" && c.args[1] === "p1")).toBe(true);
  });

  it("关了开关就什么都不发，也不去查登录状态", async () => {
    const f = fake(status("ou_a"));
    const r = await sendOnlineNotice(cfg({ notifyOnline: false }), info, f.exec);
    expect(r.sent).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("lark-cli 没登录用户：退回「允许的用户」里的第一个；都没有就不发", async () => {
    const a = fake(status());
    expect(await sendOnlineNotice(cfg({ allowUsers: ["ou_first", "ou_second"] }), info, a.exec)).toEqual({ sent: true, to: "ou_first" });
    const b = fake(status());
    const r = await sendOnlineNotice(cfg(), info, b.exec);
    expect(r.sent).toBe(false);
    expect(b.calls.some(c => c.args.includes("+messages-send"))).toBe(false);
  });

  it("发送失败：只返回原因，不抛错", async () => {
    const r = await sendOnlineNotice(cfg(), info, fake(status("ou_a"), 1).exec);
    expect(r.sent).toBe(false);
    expect((r as { reason: string }).reason).toContain("boom");
  });

  it("查登录状态时 lark-cli 本身出错（比如没装）：也只是不发", async () => {
    const exec: Exec = async args => {
      if (args.includes("auth")) throw new Error("spawn lark-cli ENOENT");
      return { code: -1, stdout: "", stderr: "spawn lark-cli ENOENT" };
    };
    const r = await sendOnlineNotice(cfg({ allowUsers: ["ou_z"] }), info, exec);
    expect(r.sent).toBe(false);
  });

  it("parseUserOpenId：前后夹着别的文字也能取到；格式不对返回空", () => {
    expect(parseUserOpenId(`warn: x\n${status("ou_k9")}\ndone`)).toBe("ou_k9");
    expect(parseUserOpenId("not json")).toBeUndefined();
    expect(parseUserOpenId(status("bad id"))).toBeUndefined();
  });

  it("配置里 notifyOnline 默认是开（界面上没有开关，需要关的人在配置文件里写 false）", () => {
    expect(cfg().notifyOnline).not.toBe(false);
    expect(noticeText(info)).toContain("M-Harness 已上线");
    expect(noticeText(info)).not.toContain("关掉");
  });
});
