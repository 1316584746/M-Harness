import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DingtalkChannel, dingtalkSign } from "../src/channels/dingtalk";
import { FeishuChannel, decryptFeishu, encryptFeishu } from "../src/channels/feishu";
import { SessionManager } from "../src/channels/session";
import { chunkText, type IncomingMessage } from "../src/channels/types";
import { parseConfig } from "../src/config";
import { Runtime } from "../src/runtime";
import { startEchoLlm } from "./helpers/echo-llm";

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const flush = () => new Promise(r => setTimeout(r, 20));

function fakeFeishuFetch() {
  const calls: Array<{ url: string; body: any }> = [];
  const f = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
    if (u.endsWith("/tenant_access_token/internal")) return json({ code: 0, tenant_access_token: "t-xxx", expire: 7200 });
    if (u.endsWith("/bot/v3/info")) return json({ code: 0, bot: { open_id: "ou_bot" } });
    return json({ code: 0 });
  });
  return { f: f as unknown as typeof fetch, calls };
}

const feishuEvent = (over: any = {}) => ({
  schema: "2.0",
  header: { event_id: "e1", event_type: "im.message.receive_v1", token: "vt" },
  event: {
    sender: { sender_type: "user", sender_id: { open_id: "ou_user" } },
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "你好" }),
      ...over,
    },
  },
});

describe("飞书", () => {
  const cfg = { appId: "a", appSecret: "s", verificationToken: "vt", encryptKey: "", apiBase: "https://open.feishu.cn", groupRequireMention: true };

  it("url_verification 返回 challenge；token 错误拒绝", async () => {
    const ch = new FeishuChannel(cfg, fakeFeishuFetch().f);
    const ok = await ch.handle({ headers: {}, rawBody: JSON.stringify({ type: "url_verification", challenge: "abc", token: "vt" }), url: new URL("http://x/") }, () => {});
    expect(ok).toEqual({ status: 200, body: { challenge: "abc" } });
    const bad = await ch.handle({ headers: {}, rawBody: JSON.stringify({ type: "url_verification", challenge: "abc", token: "no" }), url: new URL("http://x/") }, () => {});
    expect(bad.status).toBe(401);
  });

  it("单聊文本消息：立即 ack，异步派发并通过 reply API 回复", async () => {
    const { f, calls } = fakeFeishuFetch();
    const ch = new FeishuChannel(cfg, f);
    const got: IncomingMessage[] = [];
    const r = await ch.handle({ headers: {}, rawBody: JSON.stringify(feishuEvent()), url: new URL("http://x/") }, m => got.push(m));
    expect(r.status).toBe(200);
    await flush();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ channel: "feishu", conversationId: "feishu:oc_1", userId: "ou_user", text: "你好" });
    await got[0].reply("收到");
    const reply = calls.find(c => c.url.endsWith("/im/v1/messages/om_1/reply"))!;
    expect(reply.body.msg_type).toBe("text");
    expect(JSON.parse(reply.body.content).text).toBe("收到");
  });

  it("重复事件只处理一次；token 不匹配拒绝", async () => {
    const ch = new FeishuChannel(cfg, fakeFeishuFetch().f);
    const got: IncomingMessage[] = [];
    const req = { headers: {}, rawBody: JSON.stringify(feishuEvent()), url: new URL("http://x/") };
    await ch.handle(req, m => got.push(m));
    await ch.handle(req, m => got.push(m));
    await flush();
    expect(got).toHaveLength(1);
    const bad = feishuEvent();
    bad.header.token = "evil";
    expect((await ch.handle({ ...req, rawBody: JSON.stringify(bad) }, () => {})).status).toBe(401);
  });

  it("群聊只响应 @ 机器人的消息，并去掉 @ 占位符", async () => {
    const { f } = fakeFeishuFetch();
    const ch = new FeishuChannel(cfg, f);
    const got: IncomingMessage[] = [];
    const mk = (id: string, mentions: any[], text: string) => {
      const e = feishuEvent({ chat_type: "group", mentions, content: JSON.stringify({ text }) });
      e.header.event_id = id;
      return { headers: {}, rawBody: JSON.stringify(e), url: new URL("http://x/") };
    };
    await ch.handle(mk("g1", [], "闲聊"), m => got.push(m));
    await ch.handle(mk("g2", [{ key: "@_user_1", id: { open_id: "ou_other" } }], "@_user_1 别人"), m => got.push(m));
    await ch.handle(mk("g3", [{ key: "@_user_1", id: { open_id: "ou_bot" } }], "@_user_1 查一下"), m => got.push(m));
    await flush();
    expect(got.map(m => m.text)).toEqual(["查一下"]);
  });

  it("加密事件：解密 + 签名校验", async () => {
    const key = "my-encrypt-key";
    const cfg2 = { ...cfg, encryptKey: key };
    const plain = JSON.stringify({ type: "url_verification", challenge: "zzz", token: "vt" });
    expect(decryptFeishu(encryptFeishu(plain, key), key)).toBe(plain);

    const rawBody = JSON.stringify({ encrypt: encryptFeishu(plain, key) });
    const ts = "1700000000";
    const nonce = "n1";
    const signature = crypto.createHash("sha256").update(ts + nonce + key + rawBody).digest("hex");
    const ch = new FeishuChannel(cfg2, fakeFeishuFetch().f);
    const headers = { "x-lark-request-timestamp": ts, "x-lark-request-nonce": nonce, "x-lark-signature": signature };
    expect(await ch.handle({ headers, rawBody, url: new URL("http://x/") }, () => {})).toEqual({ status: 200, body: { challenge: "zzz" } });
    expect((await ch.handle({ headers: { ...headers, "x-lark-signature": "bad" }, rawBody, url: new URL("http://x/") }, () => {})).status).toBe(401);
    expect((await ch.handle({ headers: {}, rawBody, url: new URL("http://x/") }, () => {})).status).toBe(401);
  });
});

describe("钉钉", () => {
  const cfg = { appSecret: "sec", allowUsers: [] as string[] };
  const body = (over: any = {}) => ({
    msgtype: "text",
    text: { content: " 你好 " },
    msgId: "m1",
    conversationId: "cid1",
    senderStaffId: "u1",
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=xx",
    ...over,
  });
  const signed = (b: unknown, ts = String(Date.now())) => ({
    headers: { timestamp: ts, sign: dingtalkSign(ts, "sec") },
    rawBody: JSON.stringify(b),
    url: new URL("http://x/"),
  });

  it("签名校验：正确放行，错误/过期拒绝", async () => {
    const ch = new DingtalkChannel(cfg, vi.fn() as any);
    expect((await ch.handle(signed(body()), () => {})).status).toBe(200);
    expect((await ch.handle({ ...signed(body({ msgId: "m2" })), headers: { timestamp: String(Date.now()), sign: "bad" } }, () => {})).status).toBe(401);
    const old = String(Date.now() - 2 * 3600_000);
    expect((await ch.handle(signed(body({ msgId: "m3" }), old), () => {})).status).toBe(401);
  });

  it("派发消息并通过 sessionWebhook 回复；重复 msgId 忽略", async () => {
    const f = vi.fn(async () => json({ errcode: 0 }));
    const ch = new DingtalkChannel(cfg, f as any);
    const got: IncomingMessage[] = [];
    await ch.handle(signed(body()), m => got.push(m));
    await ch.handle(signed(body()), m => got.push(m));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ conversationId: "dingtalk:cid1", userId: "u1", text: "你好" });
    await got[0].reply("收到");
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toContain("sendBySession");
    expect(JSON.parse(init.body)).toEqual({ msgtype: "text", text: { content: "收到" } });
  });

  it("allowUsers 白名单", async () => {
    const ch = new DingtalkChannel({ ...cfg, allowUsers: ["boss"] }, vi.fn() as any);
    const got: IncomingMessage[] = [];
    await ch.handle(signed(body()), m => got.push(m));
    expect(got).toHaveLength(0);
  });
});

describe("会话管理（指令 / 模型切换 / 上下文）", () => {
  let rt!: Runtime;
  let llm!: Awaited<ReturnType<typeof startEchoLlm>>;
  beforeAll(async () => {
    llm = await startEchoLlm();
    rt = new Runtime(parseConfig({ defaultProvider: "a", traceDir: ".traces-test", providers: { a: llm.provider, b: llm.provider } }));
  });
  afterAll(() => llm.close());
  const mk = (replies: string[]) => ({
    channel: "dev",
    conversationId: "c",
    userId: "u",
    text: "",
    reply: async (t: string) => void replies.push(t),
  });
  const send = async (sm: SessionManager, text: string) => {
    const out: string[] = [];
    await sm.handle({ ...mk(out), text });
    return out.join("\n");
  };

  it("普通消息走模型；/models /model /reset /help", async () => {
    const sm = new SessionManager(rt, () => {});
    expect(await send(sm, "你好")).toContain("【echo】你好");
    expect(await send(sm, "/models")).toContain("👉 a");
    expect(await send(sm, "/model b")).toContain("已切换到 b");
    expect(await send(sm, "/models")).toContain("👉 b");
    expect(await send(sm, "/model zzz")).toContain("没有名为 zzz");
    expect(await send(sm, "/reset")).toContain("已清空");
    expect(await send(sm, "/help")).toContain("/model <名称>");
    expect(await send(sm, "/wat")).toContain("未知指令");
  });

  it("同一会话消息串行处理", async () => {
    const sm = new SessionManager(rt, () => {});
    const order: string[] = [];
    const m = (text: string): IncomingMessage => ({ ...mk([]), text, reply: async t => void order.push(t) });
    await Promise.all([sm.handle(m("一")), sm.handle(m("二")), sm.handle(m("三"))]);
    expect(order).toEqual(["【echo】一", "【echo】二", "【echo】三"]);
  });
});

describe("工具函数", () => {
  it("chunkText 分段不超限", () => {
    const parts = chunkText(("行".repeat(100) + "\n").repeat(100), 1000);
    expect(parts.every(p => p.length <= 1000)).toBe(true);
    expect(parts.join("\n").replace(/\n/g, "").length).toBe(10000);
  });
});
