import { isBound, type LarkCliCfg } from "./lark-cli";
import { resolveRecipient, type Exec } from "./online-notice";
import { chunkText } from "./types";

/**
 * 把软件里的对话和结果同步到用户自己的飞书智能体（机器人单聊）里：
 * 你在软件里问了什么、跑完的结果是什么，都会在飞书里和机器人的聊天里看到，手机上也能随时翻。
 *
 * 只发给你本人；发不出去（没登录 / 没配飞书 / 网络问题）只记一行日志，绝不影响软件里的对话。
 */

export interface RunSummary {
  reason: string;
  text?: string;
  error?: string;
}

const QUOTE_MAX = 600;
const CHUNK = 3000;
const MAX_PENDING = 20;
const TARGET_TTL = 5 * 60_000;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 你在软件里问的话：标题 + 引用 */
export function questionText(title: string, question: string, images = 0): string {
  const q = clip(question.trim(), QUOTE_MAX).split("\n").map(l => `> ${l}`).join("\n");
  const pics = images > 0 ? `\n> （附 ${images} 张图片）` : "";
  return `💬 **你在 app**｜${clip(oneLine(title), 60)}\n\n${q}${pics}`;
}

/** 一轮跑完的结果：状态 + 正文，超长按段拆开（每段都是一条独立消息） */
export function answerTexts(title: string, r: RunSummary): string[] {
  const t = clip(oneLine(title), 60);
  const body = (r.text ?? "").trim();
  if (r.reason === "final") return chunkText(`✅ **${t}**｜已完成\n\n${body || "（模型没有返回内容）"}`, CHUNK).map((s, i) => (i === 0 ? s : `（续 ${i + 1}）\n${s}`));
  if (r.reason === "aborted") return [`⏹ **${t}**｜已中断${body ? `\n\n${clip(body, 1500)}` : ""}`];
  if (r.reason === "max_steps") return chunkText(`⚠️ **${t}**｜达到步数上限，先停在这里\n\n${body}`, CHUNK);
  return [`⚠️ **${t}**｜运行失败\n\n${clip(r.error || body || r.reason, 1500)}`];
}

export class FeishuMirror {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private cache?: { to: string; at: number };

  constructor(
    private getCfg: () => LarkCliCfg | undefined,
    private makeExec: (cfg: LarkCliCfg) => Exec,
    private log: (s: string) => void = () => {},
  ) {}

  /** 绑定了 M-Harness 自己的机器人、且没在设置里关掉同步（没绑定时不能借用本机别的软件的机器人发消息） */
  enabled(): boolean {
    const c = this.getCfg();
    return !!c && isBound(c) && c.mirror !== false;
  }

  question(title: string, question: string, images = 0): void {
    this.enqueue([questionText(title, question, images)]);
  }

  answer(title: string, r: RunSummary): void {
    this.enqueue(answerTexts(title, r));
  }

  /** 首次建好智能体后的欢迎语（要等发送结果，让向导能报告成败） */
  async welcome(text: string): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.getCfg();
    if (!cfg) return { ok: false, error: "没有配置飞书通道" };
    this.cache = undefined;
    const err = await this.send(cfg, text);
    return err ? { ok: false, error: err } : { ok: true };
  }

  /** 等排队里的消息都发完（测试和退出前用） */
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueue(texts: string[]): void {
    if (!this.enabled()) return;
    if (this.pending >= MAX_PENDING) {
      this.log("飞书同步：积压太多，这条没有发");
      return;
    }
    this.pending += texts.length;
    for (const text of texts) {
      this.chain = this.chain.then(async () => {
        try {
          const cfg = this.getCfg();
          if (!cfg || cfg.mirror === false) return;
          const err = await this.send(cfg, text);
          if (err) this.log(`飞书同步没发出去：${err}`);
        } catch (e: any) {
          this.log(`飞书同步没发出去：${e?.message ?? e}`);
        } finally {
          this.pending--;
        }
      });
    }
  }

  private async recipient(cfg: LarkCliCfg, exec: Exec): Promise<string | undefined> {
    if (this.cache && Date.now() - this.cache.at < TARGET_TTL) return this.cache.to;
    const to = await resolveRecipient(cfg, exec);
    if (to) this.cache = { to, at: Date.now() };
    return to;
  }

  /** 发一条；成功返回 undefined，失败返回原因 */
  private async send(cfg: LarkCliCfg, text: string): Promise<string | undefined> {
    const exec = this.makeExec(cfg);
    const to = await this.recipient(cfg, exec);
    if (!to) return "不知道发给谁（lark-cli 没有登录用户，「允许的用户」里也没有人）";
    const r = await exec([...cfg.binArgs, "im", "+messages-send", "--user-id", to, "--as", "bot", "--markdown", "-"], text);
    if (r.code !== 0) {
      this.cache = undefined;
      return `lark-cli code=${r.code} ${oneLine(r.stderr || r.stdout).slice(0, 160)}`;
    }
    return undefined;
  }
}
