import type { HostTool } from "../core/types";

export interface AdvanceRequest {
  /** 要进入的下一步（build / review / plan …，或自定义动作的 id） */
  action: string;
  /** 给下一步的指令要点 */
  instruction: string;
  /** 用户原话：授权这次推进的那句 */
  userWords: string;
}

export const ADVANCE_NEXT_DESCRIPTION = [
  "用户在话里明确说了「这一步做完就继续下一步」（如「改完直接提测」「做完自动复核一遍」「review 有问题就自己改，改完再 review」）时，登记一次「本轮结束后代用户点推进」。",
  "只登记、不立刻跑：本轮正常结束（产物写完、收尾说完）后，系统才会自己开下一步。不要自己去做下一步的活。",
  "只在用户这样说过的时候用；用户没说过就不要用，正常收尾让他自己推进。授权按原话算：他说「做完复核」授权的只是复核，不等于也授权了提测。",
  "带对外副作用的步骤（dev 联调推送、ship 提测 / 提 MR、release 上线）必须是用户原话里明确点名的。",
  "user_words 必须逐字引用用户说过的那句话（不是转述）；系统会拿它去核对用户在本任务里真说过的话，对不上就不会推进、需要用户手动点。",
  "连续自动推进最多 3 步；用户中途发新消息或点停止就作废。",
].join("\n");

export const ADVANCE_NEXT_SCHEMA = {
  type: "object",
  properties: {
    user_words: { type: "string", description: "逐字引用用户授权这次推进的那句话" },
    action: { type: "string", description: "下一步：analysis / plan / build / review / dev / ship / release，或自定义动作的 id" },
    instruction: { type: "string", description: "给下一步的指令要点（新一轮看不到当前对话细节，写清用户的具体要求；用户对再往后的步骤也有授权的，把那句原话也写进来）" },
  },
  required: ["user_words", "action"],
  additionalProperties: false,
} as const;

/** 解析 Agent 传来的参数；缺必填项返回错误文案 */
export function parseAdvanceArgs(args: Record<string, unknown> | undefined): AdvanceRequest | string {
  const userWords = typeof args?.["user_words"] === "string" ? args["user_words"].trim() : "";
  const action = typeof args?.["action"] === "string" ? args["action"].trim() : "";
  const instruction = typeof args?.["instruction"] === "string" ? args["instruction"].trim() : "";
  if (!userWords) return "缺少 user_words：必须逐字引用用户授权推进的那句话。用户没说过就不要调用本工具。";
  if (!action) return "缺少 action：说明要进入哪一步。";
  return { action, instruction, userWords };
}

/** 给 Cursor Agent 的 advance_next 自定义工具：只登记，由桌面端核对授权、在本轮结束后推进 */
export function advanceNextTool(onRequest: (r: AdvanceRequest) => void): HostTool {
  return {
    description: ADVANCE_NEXT_DESCRIPTION,
    inputSchema: ADVANCE_NEXT_SCHEMA as unknown as Record<string, unknown>,
    execute: async args => {
      const r = parseAdvanceArgs(args);
      if (typeof r === "string") return JSON.stringify({ ok: false, error: r });
      onRequest(r);
      return JSON.stringify({ ok: true, note: "已登记。现在正常把本步产物写完、收尾说 1-3 句并结束本轮；不要自己去做下一步，系统核对授权后会另起一轮。" });
    },
  };
}
