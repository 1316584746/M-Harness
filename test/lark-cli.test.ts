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
      await wait(() => replies().some(x => x.args.includes("reactions") && x.body.includes("DONE")));
      const all = replies();
      const react = all.filter(x => x.args.includes("reactions"));
      const r = all.find(x => x.args.includes("+messages-reply"))!;
      expect(r.args).toEqual(expect.arrayContaining(["im", "+messages-reply", "--message-id", "om_single", "--as", "bot", "--markdown", "-"]));
      expect(r.body).toBe("【echo】请回复 你好 *粗体*");
      // 收到先点「Get」，做完回复后再点「DONE」
      expect(react.map(x => JSON.parse(x.body).reaction_type.emoji_type)).toEqual(["Get", "DONE"]);
      expect(react[0].args).toEqual(expect.arrayContaining(["im", "reactions", "create", "--message-id", "om_single", "--as", "bot", "--data", "-"]));
      expect(all.indexOf(react[0])).toBeLessThan(all.indexOf(r));
      expect(all.indexOf(react[1])).toBeGreaterThan(all.indexOf(r));
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

  describe("群里其他人 @ 机器人提问（访客）", () => {
    const botExec = async (args: string[]) => ({ code: 0, stdout: args.includes("api") ? JSON.stringify({ data: { open_id: "ou_bot" } }) : "", stderr: "" });
    const atBot = (over: any = {}) =>
      ev({ chat_type: "group", sender_id: "ou_guest", content: "@小助手 这个接口怎么调", mentions: [{ id: "ou_bot", key: "@_user_1", name: "小助手" }], ...over });
    const run = async (c: LarkCliCfg, events: any[]) => {
      const got: Array<{ text: string; guest?: boolean }> = [];
      const ch = new LarkCliChannel(c, () => {}, botExec);
      for (const e of events) await ch.handleEvent(e, m => got.push({ text: m.text, guest: m.guest }));
      return got;
    };

    it("不在「允许的用户」里的群成员 @ 机器人：能提问，标记为访客", async () => {
      expect(await run(cfg({ allowUsers: ["ou_owner"] }), [atBot()])).toEqual([{ text: "这个接口怎么调", guest: true }]);
    });
    it("主人自己不会被标成访客", async () => {
      expect(await run(cfg({ allowUsers: ["ou_owner"] }), [atBot({ sender_id: "ou_owner" })])).toEqual([{ text: "这个接口怎么调", guest: undefined }]);
    });
    it("访客没 @ 机器人 / 只 @ 了别人 → 不响应（即使关了「群聊需要 @」）", async () => {
      const c = cfg({ allowUsers: ["ou_owner"], groupRequireMention: false });
      const other = atBot({ content: "@张三 看下", mentions: [{ id: "ou_zhang", key: "@_user_1", name: "张三" }] });
      expect(await run(c, [atBot({ content: "闲聊", mentions: [] }), other])).toEqual([]);
    });
    it("单聊里的陌生人一律忽略", async () => {
      expect(await run(cfg({ allowUsers: ["ou_owner"] }), [atBot({ chat_type: "p2p" })])).toEqual([]);
    });
    it("groupOpen=false：只有允许的用户能在群里用", async () => {
      expect(await run(cfg({ allowUsers: ["ou_owner"], groupOpen: false }), [atBot()])).toEqual([]);
    });
    it("设了 allowChats：只响应这些群", async () => {
      const c = cfg({ allowUsers: ["ou_owner"], allowChats: ["oc_ok"] });
      expect(await run(c, [atBot({ chat_id: "oc_other" }), atBot({ chat_id: "oc_ok" })])).toHaveLength(1);
    });
    it("访客限流：每人每分钟超过上限就提示、不派发", async () => {
      const sent: string[][] = [];
      const ch = new LarkCliChannel(cfg({ allowUsers: ["ou_owner"], guestRatePerMin: 2 }), () => {}, async (args, stdin) => {
        sent.push([...args, stdin ?? ""]);
        return botExec(args);
      });
      const got: string[] = [];
      for (let i = 0; i < 3; i++) await ch.handleEvent(atBot(), m => got.push(m.text));
      expect(got).toHaveLength(2);
      expect(sent.at(-1)!.at(-1)).toContain("太频繁");
    });
  });

  it("访客在群里提问：强制只读（即使 toolPolicy 放开 / 自动批准）", () => {
    const rt = new Runtime(parseConfig({ channels: { toolPolicy: "inherit", autoApprove: true } as any }));
    const deny = (g: any) => (g as any).cfg?.policy ?? (g as any).policy;
    expect(deny(rt.guardFor("channel", true))?.write).toBe("deny");
    expect(deny(rt.guardFor("channel", false))?.write).not.toBe("deny");
  });

  it("访客不能用外部 Agent（它不受只读护栏约束）：退到模型类 provider，没有就返回 undefined", () => {
    const agent = { type: "cli", preset: "codex" } as const;
    const model = { type: "openai-compat", baseURL: "http://127.0.0.1:1", apiKey: "k", model: "m" } as const;
    const both = new Runtime(parseConfig({ defaultProvider: "agent", providers: { agent, model } as any }));
    expect(both.guestProvider("agent")).toBe("model");
    expect(both.guestProvider("model")).toBe("model");
    const only = new Runtime(parseConfig({ defaultProvider: "agent", providers: { agent } as any }));
    expect(only.guestProvider("agent")).toBeUndefined();
  });

  it("非文本消息给出提示而不派发", async () => {
    const sent: string[][] = [];
    const ch = new LarkCliChannel(cfg(), () => {}, async (args, stdin) => {
      sent.push([...args, stdin ?? ""]);
      return { code: 0, stdout: JSON.stringify({ data: { open_id: "ou_bot" } }), stderr: "" };
    });
    const got: string[] = [];
    await ch.handleEvent(ev({ message_type: "audio", content: "[语音]" }), m => got.push(m.text));
    expect(got).toEqual([]);
    expect(sent.at(-1)!.at(-1)).toContain("暂时只支持文字");
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
