import { describe, expect, it } from "vitest";
import { progressDigest } from "../desktop/renderer/src/lib/flow";

const p = (line: string, kind?: string) => ({ type: "agent_progress", line, ...(kind ? { kind } : {}) }) as any;

describe("progressDigest：失败后「继续」带上的进度摘要", () => {
  it("列出说过的话、读过的文件、搜索和命令，同一个文件只列一次", () => {
    const ev = [
      p("读建表脚本", "text"),
      p('🔧 read {"path":"a/sql/init.sql"}', "tool"),
      p("   ✓ read → ok", "tool"),
      p('🔧 read {"path":"a/sql/init.sql"}', "tool"),
      p("   ✓ read → ok", "tool"),
      p('🔧 grep {"pattern":"subscription","path":"a/src"}', "tool"),
      p("   ✓ grep → ok", "tool"),
      p('🔧 shell {"command":"git status"}', "tool"),
      p("   ✓ shell → ok", "tool"),
    ];
    const d = progressDigest(ev);
    expect(d).toContain("读建表脚本");
    expect(d).toContain("已读过的文件（1）");
    expect(d).toContain("- a/sql/init.sql");
    expect(d).toContain("已搜索过（1）");
    expect(d).toContain("subscription");
    expect(d).toContain("$ git status");
  });

  it("失败的工具调用不算已做过；什么都没有时返回空串", () => {
    expect(progressDigest([])).toBe("");
    const ev = [p('🔧 read {"path":"x.ts"}', "tool"), p("   ✗ read 失败: not found", "error")];
    expect(progressDigest(ev)).not.toContain("x.ts");
  });

  it("过长时截断", () => {
    const ev: any[] = [];
    for (let i = 0; i < 200; i++) ev.push(p(`🔧 read {"path":"some/very/long/directory/name/file-${i}-${"x".repeat(100)}.ts"}`, "tool"), p("   ✓ read → ok", "tool"));
    expect(progressDigest(ev, undefined, 2000).length).toBeLessThanOrEqual(2000 + 20);
  });
});
