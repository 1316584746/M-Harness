import crypto from "node:crypto";
import type { HarnessConfig } from "../config";
import { chunkText, header, type Channel, type IncomingMessage, type RouteRequest, type RouteResponse } from "./types";

type DingCfg = NonNullable<HarnessConfig["channels"]["dingtalk"]>;

/**
 * 钉钉企业内部机器人（HTTP 回调模式）。
 * 校验：sign = base64(HMAC-SHA256(appSecret, `${timestamp}\n${appSecret}`))，timestamp 与当前时间相差不超过 1 小时。
 * 回复：向消息里携带的 sessionWebhook POST。
 */
export class DingtalkChannel implements Channel {
  readonly name = "dingtalk";
  readonly path = "/dingtalk/callback";
  private seen = new Map<string, number>();

  constructor(private cfg: DingCfg, private fetchImpl: typeof fetch = fetch) {}

  async handle(req: RouteRequest, onMessage: (m: IncomingMessage) => void): Promise<RouteResponse> {
    const ts = header(req.headers, "timestamp");
    const sign = header(req.headers, "sign");
    if (!this.verify(ts, sign)) return { status: 401, body: { error: "bad signature" } };

    let b: any;
    try {
      b = JSON.parse(req.rawBody);
    } catch {
      return { status: 400, body: { error: "invalid json" } };
    }
    if (b.msgtype !== "text" || !b.sessionWebhook) return { status: 200, body: {} };
    if (this.isDuplicate(b.msgId)) return { status: 200, body: {} };

    const staffId: string = b.senderStaffId ?? b.senderId ?? "unknown";
    if (this.cfg.allowUsers.length && !this.cfg.allowUsers.includes(staffId)) {
      return { status: 200, body: {} };
    }
    const text = String(b.text?.content ?? "").trim();
    if (!text) return { status: 200, body: {} };

    const webhook: string = b.sessionWebhook;
    onMessage({
      channel: this.name,
      conversationId: `dingtalk:${b.conversationId}`,
      userId: staffId,
      text,
      reply: t => this.reply(webhook, t),
    });
    return { status: 200, body: {} };
  }

  async reply(webhook: string, text: string): Promise<void> {
    for (const part of chunkText(text, 3000)) {
      const res = await this.fetchImpl(webhook, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ msgtype: "text", text: { content: part } }),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || (j.errcode && j.errcode !== 0)) {
        throw new Error(`钉钉回复失败 ${res.status} errcode=${j.errcode} ${j.errmsg ?? ""}`);
      }
    }
  }

  verify(timestamp: string, sign: string, now = Date.now()): boolean {
    if (!timestamp || !sign) return false;
    if (Math.abs(now - Number(timestamp)) > 3600_000) return false;
    const expect = dingtalkSign(timestamp, this.cfg.appSecret);
    const a = Buffer.from(expect);
    const c = Buffer.from(sign);
    return a.length === c.length && crypto.timingSafeEqual(a, c);
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

export function dingtalkSign(timestamp: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
}
