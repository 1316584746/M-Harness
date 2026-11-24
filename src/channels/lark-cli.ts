import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { HarnessConfig } from "../config";
import { spawnCli } from "../tools/cli-spawn";
import { chunkText, type IncomingMessage } from "./types";

export type LarkCliCfg = NonNullable<HarnessConfig["channels"]["larkCli"]>;

const EVENT_KEY = "im.message.receive_v1";

/**
 * 飞书 CLI 通道：用官方 lark-cli 的长连接收消息、发回复，无需公网地址，也不用自己管 appId/secret/加解密。
 *
 *   收：`lark-cli event consume im.message.receive_v1 --as bot`（NDJSON，stderr 打 ready 标记）
 *   发：`lark-cli im +messages-reply --message-id <om_xxx> --as bot --markdown -`（正文走 stdin，避免转义与注入）
 *
 * 身份、密钥全部由 lark-cli 自己的登录态管理（`lark-cli auth status` 里 bot 为 ready 即可）。
 */
export class LarkCliChannel {
  readonly name = "feishu-cli";

  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  private botOpenId?: string | null;
  private seen = new Map<string, number>();
  private backoff = 2000;

  constructor(
    private cfg: LarkCliCfg,
    private log: (s: string) => void = console.log,
    /** 测试时可替换：执行一次 lark-cli 子命令并返回 stdout */
    private exec: (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }> = (a, s) =>
      runOnce(cfg, a, s),
  ) {}

  start(onMessage: (m: IncomingMessage) => void): void {
    this.stopped = false;
    this.spawnConsumer(onMessage);
  }

  stop(): void {
    this.stopped = true;
    // 不要 kill -9：让 consume 自己清理服务端订阅。关闭 stdin 即触发优雅退出，兜底再发 SIGTERM
    const c = this.child;
    if (!c) return;
    try {
      c.stdin.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGTERM");
    }, 3000).unref();
  }

  private spawnConsumer(onMessage: (m: IncomingMessage) => void) {
    const args = [...this.cfg.binArgs, "event", "consume", EVENT_KEY, "--as", "bot"];
    const child = spawnCli(this.cfg.bin, args);
    this.child = child;
    let ready = false;
    let lastErr = "";

    // 无界 consume 会把 stdin EOF 当作退出信号，所以 stdin 保持打开、不写入
    child.stdin.on("error", () => {});

    readline.createInterface({ input: child.stderr }).on("line", line => {
      if (line.includes("[event] ready")) {
        ready = true;
        this.backoff = 2000;
        this.log(`[feishu-cli] 长连接已就绪，等待消息（${EVENT_KEY}）`);
      } else if (line.trim()) {
        lastErr = line;
        this.log(`[feishu-cli] ${line}`);
      }
    });

    readline.createInterface({ input: child.stdout }).on("line", line => {
      if (!line.trim()) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      void this.handleEvent(ev, onMessage).catch(e => this.log(`[feishu-cli] 处理事件失败：${e?.message ?? e}`));
    });

    child.on("error", e => {
      this.log(`[feishu-cli] 无法启动 ${this.cfg.bin}：${e.message}（检查 channels.larkCli.bin 是否指向 lark-cli）`);
    });

    child.on("close", code => {
      if (this.stopped) return;
      // 2 = 参数/校验错误（含"已有另一个 bus 在连接"），3 = 鉴权失败：重试没有意义
      if (code === 2 || code === 3) {
        this.log(`[feishu-cli] consume 退出码 ${code}，不再重试。${lastErr}\n  提示：执行 lark-cli auth status 检查 bot 身份；执行 lark-cli event stop --all 清理残留进程`);
        return;
      }
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30_000);
      this.log(`[feishu-cli] consume 退出（code=${code}${ready ? "" : "，未就绪"}），${wait / 1000}s 后重连`);
      setTimeout(() => !this.stopped && this.spawnConsumer(onMessage), wait).unref();
    });
  }

  async handleEvent(ev: any, onMessage: (m: IncomingMessage) => void): Promise<void> {
    if (ev.type && ev.type !== EVENT_KEY) return;
    if (ev.sender_type === "bot") return; // 忽略机器人自己和其他机器人的消息，防回环
    const messageId: string | undefined = ev.message_id ?? ev.id;
    if (!messageId || this.isDuplicate(messageId)) return;

    const sender: string = ev.sender_id ?? "unknown";
    if (this.cfg.allowUsers.length && !this.cfg.allowUsers.includes(sender)) return;
    if (this.cfg.allowChats.length && !this.cfg.allowChats.includes(ev.chat_id)) return;

    const mentions: Array<{ id?: string; key?: string; name?: string }> = ev.mentions ?? [];
    const botId = await this.getBotOpenId();
    if (ev.chat_type === "group" && this.cfg.groupRequireMention) {
      const hit = botId ? mentions.some(m => m.id === botId) : mentions.length > 0;
      if (!hit) return;
    }

    const reply = (text: string) => this.reply(messageId, text);

    if (ev.message_type !== "text" && ev.message_type !== "post") {
      await reply("暂时只支持文本消息。").catch(() => {});
      return;
    }

    // lark-cli 已把 @ 渲染成显示名（"@机器人名 你好"），去掉对机器人的 @
    let text: string = String(ev.content ?? "");
    for (const m of mentions) {
      if (botId && m.id !== botId) continue;
      if (m.name) text = text.split(`@${m.name}`).join("");
      if (m.key) text = text.split(m.key).join("");
    }
    text = text.trim();
    if (!text) return;

    onMessage({
      channel: this.name,
      conversationId: `feishu:${ev.chat_id}`,
      userId: sender,
      text,
      reply,
    });
  }

  async reply(messageId: string, text: string): Promise<void> {
    const flag = this.cfg.replyFormat === "markdown" ? "--markdown" : "--text";
    for (const part of chunkText(text, 3500)) {
      const r = await this.exec(
        [...this.cfg.binArgs, "im", "+messages-reply", "--message-id", messageId, "--as", "bot", flag, "-"],
        part,
      );
      if (r.code !== 0) throw new Error(`lark-cli 回复失败 code=${r.code} ${(r.stderr || r.stdout).slice(0, 300)}`);
    }
  }

  private async getBotOpenId(): Promise<string | null> {
    if (this.botOpenId !== undefined) return this.botOpenId ?? null;
    try {
      const r = await this.exec([...this.cfg.binArgs, "api", "GET", "/open-apis/bot/v3/info", "--as", "bot"]);
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      this.botOpenId = j?.data?.open_id ?? j?.bot?.open_id ?? null;
    } catch {
      this.botOpenId = null;
    }
    if (!this.botOpenId) this.log("[feishu-cli] 取不到机器人 open_id，群聊将退化为'任何 @ 都响应'");
    return this.botOpenId ?? null;
  }

  private isDuplicate(id: string): boolean {
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > 10 * 60_000) this.seen.delete(k);
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }
}

export function runOnce(cfg: LarkCliCfg, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawnCli(cfg.bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("error", e => resolve({ code: -1, stdout, stderr: e.message }));
    child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "", "utf8");
  });
}
