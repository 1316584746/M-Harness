import { describe, expect, it } from "vitest";
import type { LarkCliCfg } from "../src/channels/lark-cli";
import { FeishuMirror, answerTexts, questionText } from "../src/channels/mirror";

const AUTH = JSON.stringify({ identities: { user: { openId: "ou_me", available: true } } });
const cfg = (o: Partial<LarkCliCfg> = {}): LarkCliCfg => ({ bin: "lark-cli", binArgs: ["--profile", "m-harness"], groupRequireMention: true, replyFormat: "markdown", allowUsers: [], allowChats: [], ...o }) as LarkCliCfg;

function rig(c: LarkCliCfg | undefined, fail = false) {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const logs: string[] = [];
  const m = new FeishuMirror(
    () => c,
    () => async (args, stdin) => {
      calls.push({ args, stdin });
      if (args.includes("auth")) return { code: 0, stdout: AUTH, stderr: "" };
      return fail ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "{}", stderr: "" };
    },
    l => logs.push(l),
  );
  return { m, calls, logs, sends: () => calls.filter(c => c.args.includes("im")) };
}

describe("飞书智能体同步：消息格式", () => {
  it("问题：标题 + 引用，长问题截断", () => {
    const t = questionText("排课需求\n分析", "第一行\n第二行");
    expect(t).toContain("你在 app");
    expect(t).toContain("排课需求 分析");
    expect(t).toContain("> 第一行\n> 第二行");
    expect(questionText("t", "x".repeat(2000))).toContain("…");
    expect(questionText("t", "hi", 2)).toContain("附 2 张图片");
  });
  it("结果：完成 / 中断 / 失败 / 超步数", () => {
    expect(answerTexts("t", { reason: "final", text: "结论" })[0]).toMatch(/^✅ \*\*t\*\*｜已完成\n\n结论/);
    expect(answerTexts("t", { reason: "final", text: "" })[0]).toContain("没有返回内容");
    expect(answerTexts("t", { reason: "aborted" })[0]).toContain("已中断");
    expect(answerTexts("t", { reason: "error", error: "缺 Key" })[0]).toContain("缺 Key");
    expect(answerTexts("t", { reason: "max_steps", text: "半截" })[0]).toContain("步数上限");
  });
  it("超长结果按段拆成多条，后面的带「续」", () => {
    const parts = answerTexts("t", { reason: "final", text: "字".repeat(7000) });
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[1]).toMatch(/^（续 2）/);
    expect(parts.every(p => p.length <= 3100)).toBe(true);
  });
});

describe("飞书智能体同步：发送", () => {
  it("按顺序发给 lark-cli 登录的本人，用机器人身份、markdown、正文走 stdin", async () => {
    const { m, sends } = rig(cfg());
    m.question("标题", "你好");
    m.answer("标题", { reason: "final", text: "答复" });
    await m.idle();
    const s = sends();
    expect(s).toHaveLength(2);
    expect(s[0].args).toEqual(expect.arrayContaining(["+messages-send", "--user-id", "ou_me", "--as", "bot", "--markdown", "-"]));
    expect(s[0].stdin).toContain("你好");
    expect(s[1].stdin).toContain("答复");
  });
  it("没登录用户时退回「允许的用户」第一个", async () => {
    const calls: string[][] = [];
    const m = new FeishuMirror(
      () => cfg({ allowUsers: ["ou_allow"] }),
      () => async args => {
        calls.push(args);
        return args.includes("auth") ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" };
      },
    );
    m.answer("t", { reason: "final", text: "x" });
    await m.idle();
    expect(calls.find(a => a.includes("im"))).toContain("ou_allow");
  });
  it("没绑定 M-Harness 自己的机器人 → 一条都不发（不借用本机别的软件的）", async () => {
    const r = rig(cfg({ binArgs: [] }));
    r.m.question("t", "q");
    await r.m.idle();
    expect(r.calls).toHaveLength(0);
  });

  it("设置里关了同步 / 没配飞书 → 一条都不发", async () => {
    const off = rig(cfg({ mirror: false }));
    off.m.question("t", "q");
    await off.m.idle();
    expect(off.calls).toHaveLength(0);
    const none = rig(undefined);
    none.m.answer("t", { reason: "final", text: "x" });
    await none.m.idle();
    expect(none.calls).toHaveLength(0);
  });
  it("发失败只记日志，不抛错，后面的照常发", async () => {
    const { m, logs } = rig(cfg(), true);
    m.question("t", "q");
    m.answer("t", { reason: "final", text: "x" });
    await m.idle();
    expect(logs.length).toBe(2);
    expect(logs[0]).toContain("没发出去");
  });
  it("welcome 返回成败", async () => {
    expect((await rig(cfg()).m.welcome("hi")).ok).toBe(true);
    const bad = await rig(cfg(), true).m.welcome("hi");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("boom");
  });
});
