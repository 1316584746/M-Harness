import { describe, expect, it } from "vitest";
import { upstreamBlock, UPSTREAM_CAP, UPSTREAM_TOTAL, type UpstreamRound } from "../desktop/renderer/src/lib/upstream";
import { fmtTokens } from "../desktop/renderer/src/lib/steps";

const round = (id: string, name: string, text: string, status = "done"): UpstreamRound => ({ user: { step: { id, name } }, ai: { status, text } });

describe("upstreamBlock：后面的步骤带上前面步骤的完整产物", () => {
  it("方案设计带业务分析；业务分析没有上游", () => {
    const rs = [round("analysis", "业务分析", "分析正文")];
    expect(upstreamBlock(rs, "plan", "方案设计")).toContain("分析正文");
    expect(upstreamBlock(rs, "analysis", "业务分析")).toBeUndefined();
  });

  it("同一步骤跑过多次只取最新一次完成的；失败的不算", () => {
    const rs = [round("analysis", "业务分析", "旧版"), round("analysis", "业务分析", "新版"), round("analysis", "业务分析", "失败", "error")];
    const b = upstreamBlock(rs, "plan", "方案设计")!;
    expect(b).toContain("新版");
    expect(b).not.toContain("旧版");
    expect(b).not.toContain("失败");
  });

  it("代码CR带方案和进行开发的产物", () => {
    const rs = [round("plan", "方案设计", "方案正文"), round("build", "进行开发", "改动记录")];
    const b = upstreamBlock(rs, "review", "代码CR")!;
    expect(b).toContain("方案正文");
    expect(b).toContain("改动记录");
  });

  it("同名的自定义动作不会把自己的产物当上游", () => {
    const rs = [round("custom-1", "方案设计", "自己的产物")];
    expect(upstreamBlock(rs, "plan", "方案设计")).toBeUndefined();
  });

  it("单份和总量都有上限", () => {
    const big = "x".repeat(UPSTREAM_CAP * 3);
    const b = upstreamBlock([round("plan", "方案设计", big), round("build", "进行开发", big)], "review", "代码CR")!;
    expect(b).toContain("已截断");
    expect(b.length).toBeLessThan(UPSTREAM_TOTAL + 1000);
  });

  it("没有任何上游产物时返回空", () => {
    expect(upstreamBlock([], "plan", "方案设计")).toBeUndefined();
  });
});

describe("fmtTokens", () => {
  it("小数字原样，上万换成「万」", () => {
    expect(fmtTokens(532)).toBe("532");
    expect(fmtTokens(12_300)).toBe("1.2 万");
    expect(fmtTokens(1_234_567)).toBe("123 万");
  });
});
