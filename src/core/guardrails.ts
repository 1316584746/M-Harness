import type { Risk, Tool } from "./types";

export type Verdict =
  | { action: "allow" }
  | { action: "ask"; reason: string }
  | { action: "deny"; reason: string };

export type Policy = "allow" | "ask" | "deny";

export interface GuardConfig {
  /** 只允许这些工具（设置后其余一律拒绝） */
  allowTools?: string[];
  /** 禁用这些工具 */
  denyTools?: string[];
  /** 按风险等级的默认策略 */
  policy?: Partial<Record<Risk, Policy>>;
  /** 额外的危险命令正则（字符串形式，便于放进 JSON 配置） */
  denyCommands?: string[];
  /** 允许访问内网/本机地址（默认 false，防 SSRF） */
  allowPrivateNetwork?: boolean;
  /** http_request 允许的域名白名单；为空表示不限 */
  allowHosts?: string[];
}

/** 无论是否审批都必须拦截的命令（跨 Windows / Unix） */
export const DEFAULT_DENY_COMMANDS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b/i,
  /\brm\s+-rf?\s+\/(\s|$)/i,
  /\b(rd|rmdir)\s+\/s\b/i,
  /\bdel\s+(\/[a-z]\s+)*\/s\b/i,
  /\bformat\s+[a-z]:/i,
  /Remove-Item\b[^\n]*-Recurse/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sh|bash|zsh|iex|powershell|pwsh)\b/i,
  /\bgit\s+push\b[^\n]*--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bchmod\s+-R\s+7{3}\b/i,
  /\breg\s+delete\b/i,
  /\bnet\s+user\b/i,
];

const PRIVATE_HOST =
  /^(localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?fe80:.*|\[?fc00:.*|\[?fd[0-9a-f]{2}:.*)$/i;

export class Guardrails {
  private deny: RegExp[];
  private policy: Record<Risk, Policy>;

  constructor(private cfg: GuardConfig = {}) {
    this.deny = [
      ...DEFAULT_DENY_COMMANDS,
      ...(cfg.denyCommands ?? []).map(s => new RegExp(s, "i")),
    ];
    this.policy = { read: "allow", write: "ask", exec: "ask", network: "ask", ...cfg.policy };
  }

  check(tool: Tool, args: any): Verdict {
    const c = this.cfg;
    if (c.denyTools?.includes(tool.name)) return { action: "deny", reason: `工具 ${tool.name} 已被禁用` };
    if (c.allowTools && !c.allowTools.includes(tool.name)) {
      return { action: "deny", reason: `工具 ${tool.name} 不在白名单内` };
    }

    if (tool.risk === "exec") {
      const cmd = String(args?.command ?? "");
      const hit = this.deny.find(r => r.test(cmd));
      if (hit) return { action: "deny", reason: `命令命中危险规则 ${hit}` };
    }

    if (tool.name === "http_request") {
      let u: URL;
      try {
        u = new URL(String(args?.url ?? ""));
      } catch {
        return { action: "deny", reason: "URL 非法" };
      }
      if (!/^https?:$/.test(u.protocol)) return { action: "deny", reason: "只允许 http/https" };
      if (!c.allowPrivateNetwork && PRIVATE_HOST.test(u.hostname)) {
        return { action: "deny", reason: `禁止访问内网/本机地址 ${u.hostname}` };
      }
      if (c.allowHosts?.length && !c.allowHosts.some(h => u.hostname === h || u.hostname.endsWith("." + h))) {
        return { action: "deny", reason: `域名 ${u.hostname} 不在白名单内` };
      }
    }

    const p = this.policy[tool.risk];
    if (p === "deny") return { action: "deny", reason: `策略禁止 ${tool.risk} 类工具` };
    if (p === "ask") return { action: "ask", reason: `${tool.risk} 类工具需要审批` };
    return { action: "allow" };
  }
}

/** 审批回调：返回 true 同意 */
export type Approver = (req: { tool: Tool; args: unknown; reason: string }) => Promise<boolean>;

export const denyAll: Approver = async () => false;
export const approveAll: Approver = async () => true;
