import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { HarnessEvent, RunResult } from "../core/types";
import type { Runtime } from "../runtime";
import { approveAll } from "../core/guardrails";

const Assertions = z
  .object({
    tool_called: z.union([z.string(), z.array(z.string())]).optional(),
    tool_not_called: z.union([z.string(), z.array(z.string())]).optional(),
    no_tool_blocked: z.boolean().optional(),
    max_steps: z.number().optional(),
    max_tokens: z.number().optional(),
    done_reason: z.enum(["final", "max_steps", "aborted", "error"]).optional(),
    final_contains: z.array(z.string()).optional(),
    final_not_contains: z.array(z.string()).optional(),
    final_regex: z.string().optional(),
    llm_judge: z.string().optional(),
  })
  .strict();

const CaseSchema = z.object({
  name: z.string(),
  input: z.string(),
  system: z.string().optional(),
  workspace: z.string().optional(),
  /** 评测里需要写/执行类工具时，显式声明自动审批 */
  auto_approve: z.boolean().default(false),
  assert: z.array(Assertions).default([]),
});

export type EvalCase = z.infer<typeof CaseSchema>;

export function loadEvalFile(file: string): EvalCase[] {
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  return z.array(CaseSchema).parse(doc);
}

export function loadEvalCases(target: string): Array<{ file: string; cases: EvalCase[] }> {
  const p = path.resolve(target);
  const files = fs.statSync(p).isDirectory()
    ? fs
        .readdirSync(p)
        .filter(f => /\.ya?ml$/i.test(f))
        .map(f => path.join(p, f))
    : [p];
  return files.map(file => ({ file, cases: loadEvalFile(file) }));
}

export interface AssertionFailure {
  assertion: string;
  detail: string;
}

export type JudgeFn = (criteria: string, input: string, output: string) => Promise<boolean>;

/** 对一次运行的事件与结果做断言，返回失败项 */
export async function checkAssertions(
  c: EvalCase,
  events: HarnessEvent[],
  r: RunResult,
  judge?: JudgeFn,
): Promise<AssertionFailure[]> {
  const fails: AssertionFailure[] = [];
  const called = new Set(events.flatMap(e => (e.type === "tool_call" ? [e.name] : [])));
  const blocked = events.filter(e => e.type === "tool_blocked");
  const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

  // 默认必须正常结束
  const expectReason = c.assert.find(a => a.done_reason)?.done_reason ?? "final";
  if (r.reason !== expectReason) {
    fails.push({ assertion: "done_reason", detail: `期望 ${expectReason}，实际 ${r.reason}${r.error ? "：" + r.error : ""}` });
  }

  for (const a of c.assert) {
    if (a.tool_called) {
      for (const n of list(a.tool_called)) if (!called.has(n)) fails.push({ assertion: "tool_called", detail: `未调用工具 ${n}` });
    }
    if (a.tool_not_called) {
      for (const n of list(a.tool_not_called)) if (called.has(n)) fails.push({ assertion: "tool_not_called", detail: `不应调用 ${n}` });
    }
    if (a.no_tool_blocked && blocked.length) {
      fails.push({ assertion: "no_tool_blocked", detail: `有 ${blocked.length} 次工具被拦截` });
    }
    if (a.max_steps !== undefined && r.steps > a.max_steps) {
      fails.push({ assertion: "max_steps", detail: `步数 ${r.steps} > ${a.max_steps}` });
    }
    if (a.max_tokens !== undefined && r.tokens > a.max_tokens) {
      fails.push({ assertion: "max_tokens", detail: `token ${r.tokens} > ${a.max_tokens}` });
    }
    for (const s of a.final_contains ?? []) {
      if (!r.text.includes(s)) fails.push({ assertion: "final_contains", detail: `结果不含「${s}」` });
    }
    for (const s of a.final_not_contains ?? []) {
      if (r.text.includes(s)) fails.push({ assertion: "final_not_contains", detail: `结果不应含「${s}」` });
    }
    if (a.final_regex && !new RegExp(a.final_regex, "s").test(r.text)) {
      fails.push({ assertion: "final_regex", detail: `结果不匹配 /${a.final_regex}/` });
    }
    if (a.llm_judge) {
      if (!judge) fails.push({ assertion: "llm_judge", detail: "未配置裁判模型（--judge <provider>）" });
      else if (!(await judge(a.llm_judge, c.input, r.text))) {
        fails.push({ assertion: "llm_judge", detail: `裁判判定不通过：${a.llm_judge}` });
      }
    }
  }
  return fails;
}

export interface CaseReport {
  provider: string;
  file: string;
  name: string;
  pass: boolean;
  steps: number;
  tokens: number;
  ms: number;
  failures: AssertionFailure[];
  traceFile: string;
}

export async function runEval(
  rt: Runtime,
  suites: Array<{ file: string; cases: EvalCase[] }>,
  providers: string[],
  judge?: JudgeFn,
  onCase?: (r: CaseReport) => void,
): Promise<CaseReport[]> {
  const reports: CaseReport[] = [];
  for (const provider of providers) {
    for (const suite of suites) {
      for (const c of suite.cases) {
        const events: HarnessEvent[] = [];
        const t0 = Date.now();
        let rep: CaseReport;
        try {
          const r = await rt.runTask({
            input: c.input,
            provider,
            system: c.system,
            workspace: c.workspace ? path.resolve(path.dirname(suite.file), c.workspace) : undefined,
            approve: c.auto_approve ? approveAll : undefined,
            emit: e => events.push(e),
          });
          const failures = await checkAssertions(c, events, r, judge);
          rep = {
            provider,
            file: path.basename(suite.file),
            name: c.name,
            pass: failures.length === 0,
            steps: r.steps,
            tokens: r.tokens,
            ms: Date.now() - t0,
            failures,
            traceFile: r.traceFile,
          };
        } catch (e: any) {
          rep = {
            provider,
            file: path.basename(suite.file),
            name: c.name,
            pass: false,
            steps: 0,
            tokens: 0,
            ms: Date.now() - t0,
            failures: [{ assertion: "run", detail: e?.message ?? String(e) }],
            traceFile: "",
          };
        }
        reports.push(rep);
        onCase?.(rep);
      }
    }
  }
  return reports;
}

/** 按 provider 汇总的对比表 */
export function formatSummary(reports: CaseReport[]): string {
  const by = new Map<string, CaseReport[]>();
  for (const r of reports) by.set(r.provider, [...(by.get(r.provider) ?? []), r]);
  const rows = [["provider", "通过", "通过率", "平均步数", "总 token", "总耗时(s)"]];
  for (const [p, rs] of by) {
    const pass = rs.filter(r => r.pass).length;
    rows.push([
      p,
      `${pass}/${rs.length}`,
      `${Math.round((pass / rs.length) * 100)}%`,
      (rs.reduce((a, r) => a + r.steps, 0) / rs.length).toFixed(1),
      String(rs.reduce((a, r) => a + r.tokens, 0)),
      (rs.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1),
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map(r => [...r[i]].length * (/[\u4e00-\u9fa5]/.test(r[i]) ? 1.6 : 1))));
  return rows
    .map(r => r.map((c, i) => c + " ".repeat(Math.max(0, Math.ceil(w[i]) - Math.ceil([...c].length * (/[\u4e00-\u9fa5]/.test(c) ? 1.6 : 1))))).join("  "))
    .join("\n");
}
