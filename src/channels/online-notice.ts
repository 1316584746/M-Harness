import type { LarkCliCfg } from "./lark-cli";

export interface Exec {
  (args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface OnlineInfo {
  version: string;
  host: string;
  at: Date;
}

export type NoticeResult = { sent: true; to: string } | { sent: false; reason: string };

const pad = (n: number) => String(n).padStart(2, "0");
export const fmtTime = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function noticeText(i: OnlineInfo): string {
  return [`✅ M-Harness 已上线`, `时间：${fmtTime(i.at)}`, `电脑：${i.host}`, `版本：${i.version}`].join("\n");
}

/** 从 `lark-cli auth status` 的输出里取出当前登录用户的 open_id（输出前后可能夹着别的文字） */
export function parseUserOpenId(stdout: string): string | undefined {
  const a = stdout.indexOf("{");
  const b = stdout.lastIndexOf("}");
  if (a < 0 || b <= a) return undefined;
  try {
    const id = JSON.parse(stdout.slice(a, b + 1))?.identities?.user?.openId;
    return typeof id === "string" && /^ou_\w+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** 收件人：lark-cli 里登录的那个人；没登录时退回「允许的用户」里的第一个 */
export async function resolveRecipient(cfg: LarkCliCfg, exec: Exec): Promise<string | undefined> {
  let to: string | undefined;
  try {
    to = parseUserOpenId((await exec([...cfg.binArgs, "auth", "status"])).stdout);
  } catch {
    /* 取不到就走下面的退路 */
  }
  return to ?? cfg.allowUsers[0];
}

/**
 * 用户的 M-Harness 一打开，就由他自己的飞书机器人给他本人发一条「已上线」。
 * 收件人是 lark-cli 里登录的那个人；没登录时退回「允许的用户」里的第一个。
 * 任何一步失败都只是不发，不抛错、不影响软件使用。
 */
export async function sendOnlineNotice(cfg: LarkCliCfg, info: OnlineInfo, exec: Exec): Promise<NoticeResult> {
  if (cfg.notifyOnline === false) return { sent: false, reason: "已在设置里关闭" };
  const to = await resolveRecipient(cfg, exec);
  if (!to) return { sent: false, reason: "不知道发给谁：lark-cli 没有登录用户，「允许的用户」里也没有人" };
  const r = await exec([...cfg.binArgs, "im", "+messages-send", "--user-id", to, "--as", "bot", "--text", "-"], noticeText(info));
  if (r.code !== 0) return { sent: false, reason: `lark-cli 发送失败 code=${r.code} ${(r.stderr || r.stdout).replace(/\s+/g, " ").slice(0, 200)}` };
  return { sent: true, to };
}
