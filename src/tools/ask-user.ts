import { z } from "zod";
import type { AskQuestion, Tool } from "../core/types";

/**
 * ask_user：AI 做到一半遇到只有操作人才能定的事（有几种做法、缺信息、要确认方向）时，
 * 一次把要问的几个问题交给操作人，每个问题给几个选项，操作人也可以自己写回答。
 * 只有桌面端的对话会提供提问通道（ctx.ask）；命令行、办公通道、自动化任务里没有人在，不提供这个工具。
 */
export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "向操作人提问并等他回答。只在确实需要他做决定、而你无法自己合理判断时才用（比如多种做法各有取舍、缺关键信息、要确认影响范围）；能自己查、能做合理假设的事不要问。" +
    "一次把要问的问题都放进 questions（最多 6 个）；每个问题尽量给 2~5 个互斥的选项（把你推荐的放第一个），操作人也可以自己写回答。" +
    "返回操作人的回答；他选择跳过时返回 answered=false，这时请自己做合理假设并在最终回复里说明。",
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
  async run({ questions }: { questions: Array<{ question: string; options?: string[]; multiple?: boolean; allow_text?: boolean }> }, ctx) {
    if (!ctx.ask) return JSON.stringify({ answered: false, note: "当前环境没有人可以回答（不是桌面端的对话）。请自己做合理假设，并在最终回复里说明。" });
    const qs: AskQuestion[] = questions.map((q, i) => {
      const options = [...new Set((q.options ?? []).map(o => o.trim()).filter(Boolean))];
      return { id: `q${i + 1}`, question: q.question.trim(), ...(options.length ? { options } : {}), ...(q.multiple && options.length > 1 ? { multiple: true } : {}), allowText: options.length ? q.allow_text !== false : true };
    });
    const answers = await ctx.ask(qs, ctx.signal).catch(() => null);
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
  },
};
