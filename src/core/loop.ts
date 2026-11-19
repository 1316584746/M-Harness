import { ContextManager, truncate } from "./context";
import { Guardrails, denyAll, type Approver } from "./guardrails";
import type { Asker, Emit, ModelAdapter, Msg, Provider, RunResult, Tool } from "./types";
import { newRunId } from "./trace";

export interface RunOptions {
  provider: Provider;
  tools: Tool[];
  system: string;
  input: string;
  /** 之前的对话（不含 system），用于多轮会话 */
  history?: Msg[];
  maxSteps?: number;
  /** 整次运行的超时（毫秒） */
  timeoutMs?: number;
  guard?: Guardrails;
  approve?: Approver;
  /** 让 AI 能向操作人提问（ask_user 工具用） */
  ask?: Asker;
  context?: ContextManager;
  emit?: Emit;
  signal?: AbortSignal;
  /** 沙箱根目录 */
  root: string;
  runId?: string;
}

/** 统一入口：按 provider 类型走"自驱 loop"或"委托外部 Agent" */
export async function run(opts: RunOptions): Promise<RunResult> {
  const emit = opts.emit ?? (() => {});
  const runId = opts.runId ?? newRunId();
  emit({ type: "run_start", runId, provider: opts.provider.id, input: opts.input });

  const signal = withTimeout(opts.signal, opts.timeoutMs);
  const result =
    opts.provider.kind === "model"
      ? await runAgent({ ...opts, model: opts.provider.adapter, emit, signal })
      : await runDelegate({ ...opts, emit, signal, backend: opts.provider.backend });
  return result;
}

function withTimeout(signal: AbortSignal | undefined, ms: number | undefined): AbortSignal {
  const sigs: AbortSignal[] = [];
  if (signal) sigs.push(signal);
  if (ms && ms > 0) sigs.push(AbortSignal.timeout(ms));
  if (!sigs.length) return new AbortController().signal;
  return sigs.length === 1 ? sigs[0] : AbortSignal.any(sigs);
}

/** 核心：模型 → 工具调用 → 结果回填 → 继续，直到结束 */
export async function runAgent(
  opts: Omit<RunOptions, "provider" | "emit" | "signal"> & { model: ModelAdapter; emit: Emit; signal: AbortSignal },
): Promise<RunResult> {
  const { model, tools, emit, signal, root } = opts;
  const guard = opts.guard ?? new Guardrails();
  const approve = opts.approve ?? denyAll;
  const context = opts.context ?? new ContextManager({ maxTokens: 24000 }, emit);
  const maxSteps = opts.maxSteps ?? 20;
  const byName = new Map(tools.map(t => [t.name, t]));

  let messages: Msg[] = [
    { role: "system", content: opts.system },
    ...(opts.history ?? []),
    { role: "user", content: opts.input },
  ];
  let steps = 0;
  let tokens = 0;

  const finish = (reason: RunResult["reason"], text = "", error?: string): RunResult => {
    emit({ type: "done", reason, text, error });
    return { reason, text, steps, tokens, error, messages: messages.slice(1) };
  };

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) return finish("aborted", "", abortReason(signal));
    steps = step;

    messages = context.fit(messages);
    emit({ type: "model_call", step, messages });

    const t0 = Date.now();
    let reply;
    try {
      reply = await model.chat(messages, tools, signal);
    } catch (e: any) {
      if (signal.aborted) return finish("aborted", "", abortReason(signal));
      return finish("error", "", `模型调用失败：${e?.message ?? e}`);
    }
    const used = reply.usage?.total ?? 0;
    tokens += used;
    emit({ type: "model_reply", step, reply, ms: Date.now() - t0, tokens: used });

    const assistant: Msg = { ...reply.message, role: "assistant", toolCalls: reply.toolCalls };
    messages.push(assistant);

    if (!reply.toolCalls?.length) return finish("final", reply.message.content);

    for (const call of reply.toolCalls) {
      let output: string;
      const tool = byName.get(call.name);
      if (!tool) {
        output = `错误：未知工具 ${call.name}，可用工具：${[...byName.keys()].join(", ")}`;
      } else {
        const parsed = tool.schema.safeParse(call.args);
        if (!parsed.success) {
          output = `参数错误：${parsed.error.message}`; // 回填给模型，让它自我纠正
        } else {
          let verdict = guard.check(tool, parsed.data);
          if (verdict.action === "ask") {
            const ok = await approve({ tool, args: parsed.data, reason: verdict.reason }).catch(() => false);
            emit({ type: "approval", step, name: tool.name, args: parsed.data, approved: ok });
            verdict = ok ? { action: "allow" } : { action: "deny", reason: "审批未通过" };
          }
          if (verdict.action === "deny") {
            emit({ type: "tool_blocked", step, name: tool.name, reason: verdict.reason });
            output = `被护栏拒绝：${verdict.reason}`;
          } else {
            emit({ type: "tool_call", step, name: tool.name, args: parsed.data });
            const t1 = Date.now();
            output = await tool.run(parsed.data, { signal, root, ask: opts.ask }).catch(e => `工具异常：${e?.message ?? e}`);
            output = truncate(output, context.maxToolOutput);
            emit({ type: "tool_result", step, name: tool.name, output, ms: Date.now() - t1 });
          }
        }
      }
      messages.push({ role: "tool", toolCallId: call.id, content: truncate(output, context.maxToolOutput) });
    }
  }
  return finish("max_steps", "", `超过最大步数 ${maxSteps}`);
}

/** 委托给自带 loop 的外部 Agent。工具由外部 Agent 自己管，harness 提供观测、超时与中断 */
export async function runDelegate(
  opts: Omit<RunOptions, "provider" | "emit" | "signal"> & {
    backend: import("./types").AgentBackend;
    emit: Emit;
    signal: AbortSignal;
  },
): Promise<RunResult> {
  const { backend, emit, signal } = opts;
  const recent = (opts.history ?? [])
    .filter(m => (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-6)
    .map(m => `${m.role === "user" ? "用户" : "助手"}：${truncate(m.content, 1500)}`)
    .join("\n");
  const prompt = [
    opts.system && `【系统要求】${opts.system}`,
    recent && `【此前对话】\n${recent}`,
    `【当前任务】\n${opts.input}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const base: Msg[] = [...(opts.history ?? []), { role: "user", content: opts.input }];
  // 中断要立刻生效：外部 Agent 在「准备中」（创建会话、提交任务）阶段往往不响应 signal，
  // 所以这里不能干等 backend.run 自己返回，而是让「中断」和「运行结束」赛跑。
  // backend 自己仍会收到 signal 去清理（杀进程 / 取消 run），只是用户界面不必等它。
  let onAbort: (() => void) | undefined;
  const aborted$ = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error(abortReason(signal)));
    if (signal.aborted) return fail();
    onAbort = fail;
    signal.addEventListener("abort", fail, { once: true });
  });
  try {
    const running = backend.run({
      prompt,
      cwd: opts.root,
      signal,
      onProgress: (line, kind) => !signal.aborted && emit({ type: "agent_progress", line, ...(kind ? { kind } : {}) }),
    });
    running.catch(() => {}); // 赛跑输了之后它再失败也不算未处理异常
    const r = await Promise.race([running, aborted$]);
    emit({ type: "done", reason: "final", text: r.text });
    return {
      reason: "final",
      text: r.text,
      steps: 1,
      tokens: r.usage?.total ?? 0,
      messages: [...base, { role: "assistant", content: r.text }],
    };
  } catch (e: any) {
    const aborted = signal.aborted;
    const error = aborted ? abortReason(signal) : `外部 Agent 失败：${e?.message ?? e}`;
    emit({ type: "done", reason: aborted ? "aborted" : "error", error });
    return { reason: aborted ? "aborted" : "error", text: "", steps: 1, tokens: 0, messages: base, error };
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortReason(signal: AbortSignal): string {
  const r: any = signal.reason;
  return r?.name === "TimeoutError" ? "运行超时" : "已中断";
}
