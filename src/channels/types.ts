import type { CardMeta, StreamHandle } from "./stream";
import type { ApprovalCardIO } from "./group-task";

export interface IncomingMessage {
  channel: string;
  /** 会话标识：同一个群 / 单聊共享一份上下文 */
  conversationId: string;
  userId: string;
  text: string;
  reply: (text: string) => Promise<void>;
  /** 群 id（oc_ 开头）；单聊也有，是和机器人的单聊会话 id */
  chatId?: string;
  /** 来自群聊 */
  isGroup?: boolean;
  /** 访客：不在「允许的用户」里、但在群里 @ 了机器人的人。只能只读提问，不能写 / 执行 / 联网，也不能用管理类指令 */
  guest?: boolean;
  /** 群里发来的图片（已下载到本机的绝对路径），发给能看图的模型 / Agent */
  images?: string[];
  /** 需要主人确认的动作用「带按钮的卡片」发（点按钮或回复文字都行）；不支持卡片的通道不提供 */
  approvalCard?: ApprovalCardIO;
  /** 流式回复：先发一条「处理中」，过程中编辑它，做完改成最终答案；不支持（或发不出）时返回 undefined，调用方退回整条发送 */
  stream?: (meta?: CardMeta) => Promise<StreamHandle | undefined>;
  /** 把本机一张图片作为图片消息回到这条消息下（Agent 生成的截图等）；不支持的通道不提供 */
  sendImage?: (file: string) => Promise<boolean>;
  /** 给这条消息点表情回应：收到 = Get（收到了、正在处理），做完 = DONE；不支持的通道不提供 */
  react?: (emoji: "Get" | "DONE") => Promise<void>;
}

export interface RouteRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  url: URL;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

export interface Channel {
  name: string;
  /** 挂在 HTTP 服务上的回调路径 */
  path: string;
  handle(req: RouteRequest, onMessage: (m: IncomingMessage) => void): Promise<RouteResponse>;
}

export function header(h: RouteRequest["headers"], name: string): string {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

/** 按字符数分段，避免超出各 OA 单条消息长度限制 */
export function chunkText(text: string, size = 3000): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}
