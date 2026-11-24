import type { HarnessConfig } from "../config";

const MAX_INSTRUCTIONS = 8000;

/**
 * 「自定义」办公平台：启用后，把用户写的说明（你们自己的 OA / 工单 / 审批系统怎么用）放进系统提示，
 * 模型再配合已接入的 MCP 服务、技能或命令行工具去调用。没启用 / 没写说明就不加。
 */
export function customOfficePrompt(office: HarnessConfig["office"] | undefined): string {
  if (office?.active !== "custom") return "";
  const text = (office.custom?.instructions ?? "").trim();
  if (!text) return "";
  const name = (office.custom?.name ?? "").trim() || "自定义办公系统";
  return `【办公集成：${name}】\n${text.length > MAX_INSTRUCTIONS ? text.slice(0, MAX_INSTRUCTIONS) + "\n…（已截断）" : text}`;
}
