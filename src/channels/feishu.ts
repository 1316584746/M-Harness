import crypto from "node:crypto";
import type { HarnessConfig } from "../config";
import { chunkText, header, type Channel, type IncomingMessage, type RouteRequest, type RouteResponse } from "./types";

type FeishuCfg = NonNullable<HarnessConfig["channels"]["feishu"]>;

/** 飞书事件订阅（HTTP 回调）。事件：im.message.receive_v1 */
export class FeishuChannel implements Channel {
  readonly name = "feishu";
  readonly path = "/feishu/events";

  private token?: { value: string; expiresAt: number };
  private botOpenId?: string | null;
  private seen = new Map<string, number>();

  constructor(private cfg: FeishuCfg, private fetchImpl: typeof fetch = fetch) {}

  async handle(req: RouteRequest, onMessage: (m: IncomingMessage) => void): Promise<RouteResponse> {
    let payload: any;
    try {
      payload = JSON.parse(req.rawBody);
    } catch {
      return { status: 400, body: { error: "invalid json" } };
    }

    if (this.cfg.encryptKey) {
      if (!this.verifySignature(req)) return { status: 401, body: { error: "bad signature" } };
      if (payload.encrypt) {
        try {
          payload = JSON.parse(decryptFeishu(payload.encrypt, this.cfg.encryptKey));
        } catch {
          return { status: 400, body: { error: "decrypt failed" } };
        }
      }
    }

    // URL 验证（配置事件订阅时飞书会发一次）
    if (payload.type === "url_verification") {
      if (this.cfg.verificationToken && payload.token !== this.cfg.verificationToken) {
        return { status: 401, body: { error: "bad token" } };
      }
      return { status: 200, body: { challenge: payload.challenge } };
    }

    // v2 事件
    const h = payload.header;
    if (!h) return { status: 200, body: {} };
    if (this.cfg.verificationToken && h.token !== this.cfg.verificationToken) {
      return { status: 401, body: { error: "bad token" } };
    }
    if (h.event_type !== "im.message.receive_v1") return { status: 200, body: {} };
    if (this.isDuplicate(h.event_id)) return { status: 200, body: {} };

    const ev = payload.event;
    const msg = ev?.message;
    if (!msg) return { status: 200, body: {} };
    if (ev.sender?.sender_type && ev.sender.sender_type !== "user") return { status: 200, body: {} };

    // 先 ack，后台异步处理（飞书 3 秒内必须响应，否则会重试）
    void this.process(ev, onMessage).catch(e => console.error("[feishu] 处理失败", e));
    return { status: 200, body: {} };
  }

  private async process(ev: any, onMessage: (m: IncomingMessage) => void) {
    const msg = ev.message;
    const reply = (text: string) => this.reply(msg.message_id, text);

    if (msg.chat_type === "group" && this.cfg.groupRequireMention) {
      if (!(await this.mentionsBot(msg.mentions))) return;
    }
    if (msg.message_type !== "text") {
      await reply("暂时只支持文本消息。");
      return;
    }

    let text = "";
    try {
      text = JSON.parse(msg.content).text ?? "";
    } catch {
      /* ignore */
    }
    for (const m of msg.mentions ?? []) text = text.split(m.key).join("");
    text = text.trim();
    if (!text) return;

    onMessage({
      channel: this.name,
      conversationId: `feishu:${msg.chat_id}`,
      userId: ev.sender?.sender_id?.open_id ?? "unknown",
      text,
      reply,
    });
  }

  async reply(messageId: string, text: string): Promise<void> {
    const token = await this.tenantToken();
    for (const part of chunkText(text, 3000)) {
      const res = await this.fetchImpl(
        `${this.cfg.apiBase}/open-apis/im/v1/messages/${messageId}/reply`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text: part }) }),
        },
      );
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || j.code) throw new Error(`飞书回复失败 ${res.status} code=${j.code} ${j.msg ?? ""}`);
    }
  }

  private async tenantToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.cfg.apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
    });
    const j: any = await res.json();
    if (j.code) throw new Error(`获取 tenant_access_token 失败 code=${j.code} ${j.msg}`);
    this.token = { value: j.tenant_access_token, expiresAt: Date.now() + j.expire * 1000 };
    return j.tenant_access_token;
  }

  /** 群里是否 @ 了本机器人；取不到机器人 open_id 时退化为"有人被 @" */
  private async mentionsBot(mentions: any[] | undefined): Promise<boolean> {
    if (!mentions?.length) return false;
    if (this.botOpenId === undefined) {
      try {
        const token = await this.tenantToken();
        const res = await this.fetchImpl(`${this.cfg.apiBase}/open-apis/bot/v3/info`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const j: any = await res.json();
        this.botOpenId = j?.bot?.open_id ?? null;
      } catch {
        this.botOpenId = null;
      }
    }
    if (!this.botOpenId) return true;
    return mentions.some(m => m.id?.open_id === this.botOpenId);
  }

  private verifySignature(req: RouteRequest): boolean {
    const sig = header(req.headers, "x-lark-signature");
    if (!sig) return false; // 配置了 Encrypt Key 后飞书必带签名头
    const ts = header(req.headers, "x-lark-request-timestamp");
    const nonce = header(req.headers, "x-lark-request-nonce");
    const calc = crypto
      .createHash("sha256")
      .update(ts + nonce + this.cfg.encryptKey + req.rawBody)
      .digest("hex");
    return calc === sig;
  }

  private isDuplicate(id: string | undefined): boolean {
    if (!id) return false;
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > 10 * 60_000) this.seen.delete(k);
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }
}

/** 飞书加密事件：AES-256-CBC，key = sha256(encryptKey)，iv = 密文前 16 字节 */
export function decryptFeishu(encrypt: string, encryptKey: string): string {
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const buf = Buffer.from(encrypt, "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString("utf8");
}

/** 测试/调试用：按飞书规则加密 */
export function encryptFeishu(plain: string, encryptKey: string): string {
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}
