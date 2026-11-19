import { describe, expect, it } from "vitest";
import { buildFlow, toolArgLine } from "../desktop/renderer/src/lib/flow";

const p = (line: string, kind?: string) => ({ type: "agent_progress", line, ...(kind ? { kind } : {}) }) as any;

describe("buildFlow", () => {
  it("把说明 + 思考 + 工具调用整理成段落，并算出工具耗时", () => {
    const ev = [
      p("先看日志", "text"),
      p("Let me ", "thinking"),
      p("try meegle", "thinking"),
      p('🔧 shell {"command":"meegle --help"}', "tool"),
      p("   ✓ shell → ok", "tool"),
      p("再拉详情", "text"),
      p('🔧 shell {"command":"meegle get"}', "tool"),
    ];
    const t = [1000, 2000, 2100, 3000, 4000, 5000, 6000];
    const segs = buildFlow(ev, t);
    expect(segs).toHaveLength(2);
    expect(segs[0].say).toBe("先看日志");
    expect(segs[0].items).toHaveLength(2);
    expect(segs[0].items[0]).toMatchObject({ kind: "think", text: "Let me try meegle" });
    expect(segs[0].items[1]).toMatchObject({ kind: "tool", name: "shell", status: "ok", ms: 1000, output: "ok" });
    expect(segs[1].items[0]).toMatchObject({ kind: "tool", status: "running" });
  });

  it("Cursor 的回复是增量片段：首尾直接相接，不插换行；状态行不算步骤", () => {
    const ev = [p("正在创建 Cursor Agent…", "status"), p("我没有", "text"), p("找到 PRD", "text"), p("\n\n- 列表项", "text"), p("Cursor 运行结束", "status")];
    const segs = buildFlow(ev, [1, 2, 3, 4, 5]);
    expect(segs).toHaveLength(1);
    expect(segs[0].say).toBe("我没有找到 PRD\n\n- 列表项");
    expect(segs[0].items).toHaveLength(0);
  });

  it("命令行 Agent 一行一条，行间补换行", () => {
    const segs = buildFlow([p("已启动 codex，等待输出…", "status"), p("第一行", "text"), p("第二行", "text")], [1, 2, 3]);
    expect(segs[0].say).toBe("第一行\n第二行");
  });

  it("工具失败行归到对应工具上", () => {
    const segs = buildFlow([p('🔧 shell {"command":"x"}', "tool"), p("   ✗ shell 失败：boom", "error")], [1, 2]);
    expect(segs[0].items[0]).toMatchObject({ status: "fail", output: "boom" });
  });

  it("工具参数一行摘要", () => {
    expect(toolArgLine("shell", '{"command":"ls -la"}')).toBe("$ ls -la");
    expect(toolArgLine("read", '{"path":"a/b.ts"}')).toBe("a/b.ts");
  });
});
