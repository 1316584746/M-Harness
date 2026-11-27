import { z } from "zod";
import type { AskQuestion, Asker, Tool } from "../core/types";

/**
 * ask_user：AI 做到一半遇到只有操作人才能定的事（有几种做法、缺信息、要确认方向）时，
 * 一次把要问的几个问题交给操作人，每个问题给几个选项，操作人也可以自己写回答。
 * 只有桌面端的对话会提供提问通道（ctx.ask）；命令行、办公通道、自动化任务里没有人在，不提供这个工具。
 * 自带 loop 的模型走下面的 askUserTool；Cursor 这类外部 Agent 通过 SDK 的 customTools 挂同一个提问通道（见 cursorAskTool）。
 */
export const ASK_USER_DESCRIPTION =
  "向操作人提问并等他回答。不确定的时候就用：需求有多种理解、多种做法各有取舍、缺关键信息、要确认影响范围、做错了不好撤销；自己看代码 / 文档 / 日志能查到的、事后好改的小细节不要问（做合理假设并说明）。" +
  "一次把要问的问题都放进 questions（最多 6 个）；每个问题尽量给 2~5 个互斥的选项（把你推荐的放第一个），操作人也可以自己写回答。" +
  "返回操作人的回答；他选择跳过时返回 answered=false，这时请自己做合理假设并在最终回复里说明。";

type RawQuestion = { question: string; options?: string[]; multiple?: boolean; allow_text?: boolean };

/** 给外部 Agent（SDK customTools）用的 JSON Schema，和下面的 zod schema 保持一致 */
export const ASK_USER_JSON_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "问题，一句话问清楚" },
          options: { type: "array", items: { type: "string" }, description: "供选择的选项（互斥的做法），可以不给" },
          multiple: { type: "boolean", description: "选项可以多选，默认单选" },
          allow_text: { type: "boolean", description: "是否允许操作人自己写回答，默认允许" },
        },
        required: ["question"],
      },
    },
  },
  required: ["questions"],
} as const;

/** 提问 → 等操作人回答 → 整理成给 AI 的 JSON 文本（两条路径共用） */
export async function askOperator(questions: RawQuestion[], ask: Asker | undefined, signal: AbortSignal): Promise<string> {
  if (!ask) return JSON.stringify({ answered: false, note: "当前环境没有人可以回答（不是桌面端的对话）。请自己做合理假设，并在最终回复里说明。" });
  const qs: AskQuestion[] = questions.slice(0, 6).map((q, i) => {
    const options = [...new Set((q.options ?? []).map(o => String(o).trim()).filter(Boolean))].slice(0, 8);
    return { id: `q${i + 1}`, question: String(q.question ?? "").trim().slice(0, 500), ...(options.length ? { options } : {}), ...(q.multiple && options.length > 1 ? { multiple: true } : {}), allowText: options.length ? q.allow_text !== false : true };
  });
  const answers = await ask(qs, signal).catch(() => null);
  if (!answers) return JSON.stringify({ answered: false, note: "操作人跳过了这次提问。请自己做合理假设，并在最终回复里说明你的假设。" });
  return JSON.stringify({
    answered: true,
    answers: qs.map(q => {
      const a = answers.find(x => x.id === q.id);
      const picked = a?.picked ?? [];
      const text = a?.text?.trim();
      return { question: q.question, picked, ...(text ? { text } : {}), answer: [...picked, ...(text ? [text] : [])].join("；") || "（没有回答）" };
    }),
  });
}

export const askUserTool: Tool = {
  name: "ask_user",
  description: ASK_USER_DESCRIPTION,
  risk: "read",
  schema: z.object({
    questions: z
      .array(
        z.object({
          question: z.string().min(1).max(500).describe("问题，一句话问清楚"),
          options: z.array(z.string().min(1).max(200)).max(8).optional().describe("供选择的选项（互斥的做法），可以不给"),
          multiple: z.boolean().optional().describe("选项可以多选，默认单选"),
          allow_text: z.boolean().optional().describe("是否允许操作人自己写回答，默认允许"),
        }),
      )
      .min(1)
      .max(6),
  }),
  async run({ questions }: { questions: RawQuestion[] }, ctx) {
    return askOperator(questions, ctx.ask, ctx.signal);
  },
};
