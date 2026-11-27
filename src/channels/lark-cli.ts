import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type { HarnessConfig } from "../config";
import { spawnCli } from "../tools/cli-spawn";
import { chunkText, type IncomingMessage } from "./types";
import { ReplyStream, type CardMeta, type StreamHandle, type StreamIO } from "./stream";
import type { ApprovalCardIO } from "./group-task";
import { approvalCard, approvalDoneCard, parseCardAction, progressCard, type CardAction } from "./cards";
import { MAX_FILES, MAX_IMAGES, downloadResource, explainFeishuError, fetchMessage, parseAttachments, quoteBlock, quoteLimiter, type Exec } from "./feishu-api";

export type LarkCliCfg = NonNullable<HarnessConfig["channels"]["larkCli"]>;

const EVENT_KEY = "im.message.receive_v1";
const ACTION_KEY = "card.action.trigger";

/**
 * M-Harness 自己的飞书机器人用 lark-cli 的这个独立配置（profile）：和本机上别的软件（比如 Flowship）用的机器人互不相干，
 * 不会共用同一个机器人，也不会同一条消息被两个软件各回复一次。
 */
export const MH_PROFILE = "m-harness";

/** 这份配置是不是已经绑定了 M-Harness 自己的机器人（binArgs 里指定了专属 profile） */
export function isBound(cfg: Pick<LarkCliCfg, "binArgs"> | undefined): boolean {
  const a = cfg?.binArgs ?? [];
  const i = a.indexOf("--profile");
  return i >= 0 && a[i + 1] === MH_PROFILE;
}

/**
 * 打开软件时要不要自动启动飞书通道。
 * - 没绑定 M-Harness 自己的机器人：不启动（要先创建，不能借用本机别的软件的机器人）
 * - 没设「允许的用户 / 群」时不自动启动：否则任何人给机器人发消息都能驱动模型
 */
export function autoStartDecision(cfg: Pick<LarkCliCfg, "autoStart" | "allowUsers" | "allowChats" | "binArgs"> | undefined): { start: boolean; reason?: string } {
  if (!cfg) return { start: false };
  if (cfg.autoStart === false) return { start: false, reason: "已在设置里关闭「打开软件时自动启动」" };
  if (!isBound(cfg)) return { start: false, reason: "还没有绑定 M-Harness 自己的飞书机器人，请先点「一键创建智能体」" };
  if (!cfg.allowUsers?.length && !cfg.allowChats?.length) return { start: false, reason: "还没设置「允许的用户」，为避免被陌生人驱动，请先添加自己再手动启动" };
  return { start: true };
}

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

  private consumers = new Map<string, { child?: ChildProcessWithoutNullStreams; backoff: number }>();
  private stopped = false;
  private botOpenId?: string | null;
  private seen = new Map<string, number>();
  private quoteOk = quoteLimiter();

  constructor(
    private cfg: LarkCliCfg,
    private log: (s: string) => void = console.log,
    /** 测试时可替换：执行一次 lark-cli 子命令并返回 stdout */
    private exec: Exec = (a, s, cwd) => runOnce(cfg, a, s, cwd),
    /** attachDir：群里发来的图片 / 文件下载到哪（不给就不读附件） */
    private opts: { attachDir?: string } = {},
  ) {}

  /** onAction：点了卡片上的按钮（确认 / 取消）时回调；不给就不监听卡片事件 */
  start(onMessage: (m: IncomingMessage) => void, onAction?: (a: CardAction) => void): void {
    this.stopped = false;
    this.spawnConsumer(EVENT_KEY, ev => void this.handleEvent(ev, onMessage).catch(e => this.log(`[feishu-cli] 处理事件失败：${e?.message ?? e}`)));
    if (onAction && this.cfg.card !== false) {
      this.spawnConsumer(ACTION_KEY, ev => {
        const a = parseCardAction(ev);
        if (a) onAction(a);
      });
    }
  }

  stop(): void {
    this.stopped = true;
    // 不要 kill -9：让 consume 自己清理服务端订阅。关闭 stdin 即触发优雅退出，兜底再发 SIGTERM
    for (const { child: c } of this.consumers.values()) {
      if (!c) continue;
      try {
        c.stdin.end();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (c.exitCode === null) c.kill("SIGTERM");
      }, 3000).unref();
    }
  }

  private spawnConsumer(key: string, onEvent: (ev: any) => void) {
    const slot = this.consumers.get(key) ?? { backoff: 2000 };
    this.consumers.set(key, slot);
    const args = [...this.cfg.binArgs, "event", "consume", key, "--as", "bot"];
    const child = spawnCli(this.cfg.bin, args);
    slot.child = child;
    let ready = false;
    let lastErr = "";

    // 无界 consume 会把 stdin EOF 当作退出信号，所以 stdin 保持打开、不写入
    child.stdin.on("error", () => {});

    readline.createInterface({ input: child.stderr }).on("line", line => {
      if (line.includes("[event] ready")) {
        ready = true;
        slot.backoff = 2000;
        this.log(`[feishu-cli] 长连接已就绪，等待${key === EVENT_KEY ? "消息" : "卡片点击"}（${key}）`);
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
      onEvent(ev);
    });

    child.on("error", e => {
      this.log(`[feishu-cli] 无法启动 ${this.cfg.bin}：${e.message}（检查 channels.larkCli.bin 是否指向 lark-cli）`);
    });

    child.on("close", code => {
      if (this.stopped) return;
      // 2 = 参数/校验错误（含"已有另一个 bus 在连接"），3 = 鉴权失败：重试没有意义
      if (code === 2 || code === 3) {
        this.log(`[feishu-cli] consume ${key} 退出码 ${code}，不再重试。${lastErr}${key === ACTION_KEY ? "\n  （卡片按钮点击收不到时，群里的确认仍可直接回复「确认 / 取消」）" : "\n  提示：执行 lark-cli auth status 检查 bot 身份；执行 lark-cli event stop --all 清理残留进程"}`);
        return;
      }
      const wait = slot.backoff;
      slot.backoff = Math.min(slot.backoff * 2, 30_000);
      this.log(`[feishu-cli] consume ${key} 退出（code=${code}${ready ? "" : "，未就绪"}），${wait / 1000}s 后重连`);
      setTimeout(() => !this.stopped && this.spawnConsumer(key, onEvent), wait).unref();
    });
  }

  async handleEvent(ev: any, onMessage: (m: IncomingMessage) => void): Promise<void> {
    if (ev.type && ev.type !== EVENT_KEY) return;
    if (ev.sender_type === "bot") return; // 忽略机器人自己和其他机器人的消息，防回环
    const messageId: string | undefined = ev.message_id ?? ev.id;
    if (!messageId || this.isDuplicate(messageId)) return;
    this.lastInboundAt = Date.now(); // 收到过真人消息（测试机器人时用来判断「收」是不是通的）

    const sender: string = ev.sender_id ?? "unknown";
    if (this.cfg.allowChats.length && !this.cfg.allowChats.includes(ev.chat_id)) return;
    const isOwner = !this.cfg.allowUsers.length || this.cfg.allowUsers.includes(sender);
    const isGroup = ev.chat_type === "group";
    // 访客：不在「允许的用户」里、但在群里 @ 了机器人的群成员（单聊里的陌生人仍然一律忽略）
    const guest = !isOwner;
    if (guest && (!isGroup || this.cfg.groupOpen === false)) return;

    const mentions: Array<{ id?: string; key?: string; name?: string }> = ev.mentions ?? [];
    const botId = await this.getBotOpenId();
    if (isGroup && (this.cfg.groupRequireMention || guest)) {
      // 访客必须明确 @ 到机器人本身；拿不到机器人 id 时宁可不响应，也不能「任何 @ 都响应」
      const hit = botId ? mentions.some(m => m.id === botId) : !guest && mentions.length > 0;
      if (!hit) return;
    }

    const reply = (text: string) => this.reply(messageId, text);
    if (guest && !this.guestAllowed(sender)) {
      await reply("提问太频繁了，请稍等一会儿再问。").catch(() => {});
      return;
    }

    const mt: string = ev.message_type ?? "text";
    if (!["text", "post", "image", "file"].includes(mt)) {
      await reply("暂时只支持文字、图片和文件消息。").catch(() => {});
      return;
    }

    // lark-cli 已把 @ 渲染成显示名（"@机器人名 你好"），去掉对机器人的 @
    let raw: string = String(ev.content ?? "");
    for (const m of mentions) {
      if (botId && m.id !== botId) continue;
      if (m.name) raw = raw.split(`@${m.name}`).join("");
      if (m.key) raw = raw.split(m.key).join("");
    }
    const att = parseAttachments(raw, mt);
    let text = att.text.trim();

    // 图片 / 文件：下载到本机，图片交给模型看，文件把路径告诉 AI
    const images: string[] = [];
    const notes: string[] = [];
    if ((att.images.length || att.files.length) && this.opts.attachDir) {
      const dir = this.opts.attachDir;
      let lost = 0;
      for (const k of att.images.slice(0, MAX_IMAGES)) {
        const f = await downloadResource(this.exec, this.cfg.binArgs, dir, messageId, k, "image").catch(() => undefined);
        if (f) images.push(f);
        else lost++;
      }
      for (const f of att.files.slice(0, MAX_FILES)) {
        const p = await downloadResource(this.exec, this.cfg.binArgs, dir, messageId, f.key, "file", f.name).catch(() => undefined);
        if (p) notes.push(`【群里发来的文件】${f.name}：${p}`);
        else lost++;
      }
      lost += Math.max(0, att.images.length - MAX_IMAGES) + Math.max(0, att.files.length - MAX_FILES);
      if (lost) notes.push(`（有 ${lost} 个附件没能读到：太大、数量超限或下载失败）`);
    } else if (att.images.length || att.files.length) {
      notes.push("（消息里带有图片 / 文件，但当前没有可用的附件目录，没能读取）");
    }
    if (images.length) notes.unshift(`【群里发来 ${images.length} 张图片，已附在这条消息里】`);

    // 引用（回复）的消息：把被引用的内容当参考数据带上
    const parent: string | undefined = typeof ev.parent_id === "string" && ev.parent_id ? ev.parent_id : undefined;
    let quote = "";
    if (parent && this.quoteOk()) {
      const q = await fetchMessage(this.exec, this.cfg.binArgs, parent).catch(() => undefined);
      if (q) quote = quoteBlock(q, parent);
    }

    if (!text && !images.length && !notes.length && !quote) return;
    if (!text) text = images.length ? "请看附图。" : "";
    text = [quote, text, ...notes].filter(Boolean).join("\n\n").trim();
    if (!text) return;

    onMessage({
      channel: this.name,
      conversationId: `feishu:${ev.chat_id}`,
      userId: sender,
      text,
      ...(images.length ? { images } : {}),
      reply,
      guest: guest || undefined,
      chatId: ev.chat_id,
      isGroup,
      react: emoji => this.react(messageId, emoji),
      sendImage: file => this.sendImage(messageId, file),
      stream: meta => this.openStream(messageId, meta),
      approvalCard: this.cfg.card === false ? undefined : this.approvalCardIO(messageId),
    });
  }

  /**
   * 回一张图片消息。lark-cli 的 --image 只认「相对 cwd 的路径」（绝对路径会被拒），
   * 所以把 cwd 设成图片所在目录、只传文件名。
   */
  async sendImage(messageId: string, file: string): Promise<boolean> {
    const name = path.basename(file);
    const r = await this.exec([...this.cfg.binArgs, "im", "+messages-reply", "--message-id", messageId, "--as", "bot", "--image", name.startsWith("-") ? `./${name}` : name], undefined, path.dirname(file));
    if (r.code !== 0) this.log(`[feishu-cli] 发图片失败：${(r.stderr || r.stdout).slice(0, 200)}`);
    return r.code === 0;
  }

  /** 最近一次收到真人消息的时间 */
  lastInboundAt?: number;

  private reactWarned = false;
  /** 给消息点个表情回应（收到 = Get，做完 = DONE）；失败（多半是机器人没开「消息表情回复」权限）只提示一次，不影响回复 */
  async react(messageId: string, emoji: "Get" | "DONE"): Promise<void> {
    try {
      const r = await this.exec(
        [...this.cfg.binArgs, "im", "reactions", "create", "--message-id", messageId, "--as", "bot", "--data", "-"],
        JSON.stringify({ reaction_type: { emoji_type: emoji } }),
      );
      if (r.code !== 0 && !this.reactWarned) {
        this.reactWarned = true;
        this.log(`[feishu-cli] 给消息点表情失败（不影响回复；可能机器人缺少「消息表情回复」权限 im:message.reactions:write_only）：${(r.stderr || r.stdout).slice(0, 200)}`);
      }
    } catch {
      /* 表情只是锦上添花 */
    }
  }

  /** 流式回复：先回一条「处理中」，之后编辑同一条消息；拿不到消息 id（没法编辑）就返回 undefined */
  async openStream(messageId: string, meta?: CardMeta): Promise<StreamHandle | undefined> {
    const flag = this.cfg.replyFormat === "markdown" ? "--markdown" : "--text";
    const useCard = this.cfg.card !== false;
    const s = new ReplyStream(
      useCard
        ? {
            // 卡片：蓝色「处理中」一直改到最终答案（变绿）；卡片发不出来 / 改不了就自动退回文字
            send: async (text, m) => (await this.sendCard(messageId, progressCard(text, false, false, m))) ?? (await this.sendText(messageId, text, flag)),
            edit: async (id, text, final, failed, m) => (await this.patchCard(id, progressCard(text, !!final, !!failed, m))) || (await this.editText(id, text, flag)),
            reply: text => this.reply(messageId, text),
          }
        : this.textIO(messageId, flag),
      meta ? { meta } : {},
    );
    return (await s.start()) ? s : undefined;
  }

  private async sendText(messageId: string, text: string, flag: string): Promise<string | undefined> {
    const r = await this.exec([...this.cfg.binArgs, "im", "+messages-reply", "--message-id", messageId, "--as", "bot", flag, "-"], text);
    return r.code === 0 ? /"message_id"\s*:\s*"(om_[^"]+)"/.exec(r.stdout)?.[1] : undefined;
  }

  private async editText(id: string, text: string, flag: string): Promise<boolean> {
    return (await this.exec([...this.cfg.binArgs, "im", "+messages-edit", "--as", "bot", "--message-id", id, flag, "-"], text)).code === 0;
  }

  private textIO(messageId: string, flag: string): StreamIO {
    return {
      send: text => this.sendText(messageId, text, flag),
      edit: (id, text) => this.editText(id, text, flag),
      reply: text => this.reply(messageId, text),
    };
  }

  private guestHits = new Map<string, number[]>();
  /** 访客限流：每人每分钟最多 guestRatePerMin 条（默认 6） */
  private guestAllowed(sender: string): boolean {
    const now = Date.now();
    const max = this.cfg.guestRatePerMin ?? 6;
    const hits = (this.guestHits.get(sender) ?? []).filter(t => now - t < 60_000);
    if (hits.length >= max) {
      this.guestHits.set(sender, hits);
      return false;
    }
    hits.push(now);
    this.guestHits.set(sender, hits);
    return true;
  }

  async reply(messageId: string, text: string): Promise<void> {
    const flag = this.cfg.replyFormat === "markdown" ? "--markdown" : "--text";
    for (const part of chunkText(text, 3500)) {
      const r = await this.exec(
        [...this.cfg.binArgs, "im", "+messages-reply", "--message-id", messageId, "--as", "bot", flag, "-"],
        part,
      );
      if (r.code !== 0) throw new Error(this.sendError("回复", r));
    }
  }

  /** 发送失败的报错：附上能认出来的原因和处理办法（被移出群 / 禁言 / 缺权限 …） */
  private sendError(what: string, r: { code: number; stdout: string; stderr: string }): string {
    const raw = (r.stderr || r.stdout).slice(0, 300);
    const why = explainFeishuError(r.stderr + r.stdout);
    return `lark-cli ${what}失败 code=${r.code} ${raw}${why ? `\n  → ${why.reason}。${why.hint}` : ""}`;
  }

  /** 发一张卡片（回复某条消息），返回卡片消息 id */
  private async sendCard(replyTo: string, card: string): Promise<string | undefined> {
    const r = await this.exec([...this.cfg.binArgs, "im", "+messages-reply", "--message-id", replyTo, "--as", "bot", "--msg-type", "interactive", "--content", card]);
    if (r.code !== 0) {
      this.log(`[feishu-cli] 发卡片失败，退回文字：${this.sendError("发卡片", r)}`);
      return undefined;
    }
    return /"message_id"\s*:\s*"(om_[^"]+)"/.exec(r.stdout)?.[1];
  }

  /** 改一张已发的卡片 */
  private async patchCard(messageId: string, card: string): Promise<boolean> {
    const r = await this.exec([...this.cfg.binArgs, "api", "PATCH", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, "--data", JSON.stringify({ content: card }), "--as", "bot"]);
    return r.code === 0;
  }

  /** 需要确认的动作：发一张带「确认 / 取消」按钮的卡片，结果出来后把按钮换成结论 */
  private approvalCardIO(messageId: string): ApprovalCardIO {
    return {
      open: async (token, prompt) => {
        const id = await this.sendCard(messageId, approvalCard(prompt, token));
        if (!id) return undefined;
        return (verdict, by) => void this.patchCard(id, approvalDoneCard(prompt, verdict, by)).catch(() => {});
      },
    };
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

export function runOnce(cfg: LarkCliCfg, args: string[], stdin?: string, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawnCli(cfg.bin, args, cwd ? { cwd } : {});
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
