import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LarkCliChannel, type LarkCliCfg } from "../src/channels/lark-cli";
import { SessionManager } from "../src/channels/session";
import { parseConfig } from "../src/config";
import { Runtime } from "../src/runtime";
import { startEchoLlm } from "./helpers/echo-llm";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake lark-"));
const eventsFile = path.join(dir, "events.ndjson");
const outFile = path.join(dir, "replies.ndjson");

// 假的 lark-cli：模拟 `event consume`（ready 标记 + NDJSON）、`api GET bot/v3/info`、`im +messages-reply`
const fake = path.join(dir, "fake-lark-cli.mjs");
fs.writeFileSync(
  fake,
  `import fs from "node:fs";
const a = process.argv.slice(2);
const events = process.env.FAKE_EVENTS, out = process.env.FAKE_OUT;
if (a[0] === "event") {
  console.error("[event] ready event_key=im.message.receive_v1");
  for (const l of fs.readFileSync(events, "utf8").split("\\n").filter(Boolean)) console.log(l);
  process.stdin.resume();               // 无界运行：stdin EOF = 优雅退出
  process.stdin.on("end", () => { console.error("[event] exited — reason: signal"); process.exit(0); });
} else if (a[0] === "api") {
  console.log(JSON.stringify({ ok: true, data: { open_id: "ou_bot" } }));
} else if (a[0] === "im") {
  let s = ""; process.stdin.on("data", d => s += d);
  process.stdin.on("end", () => {
    fs.appendFileSync(out, JSON.stringify({ args: a, body: s }) + "\\n");
    console.log(JSON.stringify({ ok: true }));
  });
}`,
);

const cfg = (over: Partial<LarkCliCfg> = {}): LarkCliCfg => ({
  bin: process.execPath,
  binArgs: [fake],
  groupRequireMention: true,
  replyFormat: "markdown",
  allowUsers: [],
  allowChats: [],
  ...over,
});

const ev = (over: any) => ({
  type: "im.message.receive_v1",
  chat_id: "oc_1",
  chat_type: "p2p",
  message_id: "om_" + Math.random().toString(36).slice(2),
  message_type: "text",
  sender_id: "ou_user",
  sender_type: "user",
  content: "你好",
  mentions: [],
  ...over,
});

const wait = async (cond: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms && !cond(); t += 50) await new Promise(r => setTimeout(r, 50));
};
const replies = () => (fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);

describe("飞书 CLI 通道（lark-cli 长连接）", () => {
  it("单聊：消费事件 → 会话处理 → 通过 `im +messages-reply` 回复（正文走 stdin）", async () => {
    process.env.FAKE_EVENTS = eventsFile;
    process.env.FAKE_OUT = outFile;
    fs.writeFileSync(eventsFile, JSON.stringify(ev({ message_id: "om_single", content: "请回复 你好 *粗体*" })) + "\n");
    fs.rmSync(outFile, { force: true });

    const llm = await startEchoLlm();
    const rt = new Runtime(parseConfig({ traceDir: path.join(dir, "traces"), defaultProvider: "echo", providers: { echo: llm.provider } }));
    const sessions = new SessionManager(rt, () => {});
    const ch = new LarkCliChannel(cfg(), () => {});
    ch.start(m => void sessions.handle(m));
    try {
      await wait(() => replies().length > 0);
      const r = replies()[0];
      expect(r.args).toEqual(expect.arrayContaining(["im", "+messages-reply", "--message-id", "om_single", "--as", "bot", "--markdown", "-"]));
      expect(r.body).toBe("【echo】请回复 你好 *粗体*");
    } finally {
      ch.stop();
      await llm.close();
    }
  });

  it("过滤：机器人消息、重复消息、群里没 @ 机器人、@ 了别人、白名单之外", async () => {
    const got: string[] = [];
    const ch = new LarkCliChannel(cfg({ allowUsers: ["ou_user"] }), () => {});
    const push = (e: any) => ch.handleEvent(e, m => got.push(m.text));

    await push(ev({ sender_type: "bot", content: "我是机器人" }));
    const dup = ev({ message_id: "om_dup", content: "重复" });
    await push(dup);
    await push(dup);
    await push(ev({ chat_type: "group", content: "闲聊" }));
    await push(ev({ chat_type: "group", content: "@张三 看下", mentions: [{ id: "ou_zhang", key: "@_user_1", name: "张三" }] }));
    await push(ev({ sender_id: "ou_stranger", content: "陌生人" }));
    await push(
      ev({
        chat_type: "group",
        content: "@小助手 帮我查一下 @张三",
        mentions: [
          { id: "ou_bot", key: "@_user_1", name: "小助手" },
          { id: "ou_zhang", key: "@_user_2", name: "张三" },
        ],
      }),
    );
    expect(got).toEqual(["重复", "帮我查一下 @张三"]);
  });

  it("非文本消息给出提示而不派发", async () => {
    const sent: string[][] = [];
    const ch = new LarkCliChannel(cfg(), () => {}, async (args, stdin) => {
      sent.push([...args, stdin ?? ""]);
      return { code: 0, stdout: JSON.stringify({ data: { open_id: "ou_bot" } }), stderr: "" };
    });
    const got: string[] = [];
    await ch.handleEvent(ev({ message_type: "image", content: "[图片]" }), m => got.push(m.text));
    expect(got).toEqual([]);
    expect(sent.at(-1)!.at(-1)).toContain("暂时只支持文本");
  });

  it("回复失败（非 0 退出码）会抛出，由会话层兜底记录", async () => {
    const ch = new LarkCliChannel(cfg(), () => {}, async () => ({ code: 1, stdout: "", stderr: "permission denied" }));
    await expect(ch.reply("om_x", "hi")).rejects.toThrow("permission denied");
  });

  it("长回复自动分段", async () => {
    const calls: string[] = [];
    const ch = new LarkCliChannel(cfg(), () => {}, async (_a, stdin) => {
      calls.push(stdin ?? "");
      return { code: 0, stdout: "{}", stderr: "" };
    });
    await ch.reply("om_x", ("很长的一行内容\n").repeat(1000));
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every(c => c.length <= 3500)).toBe(true);
  });
});
