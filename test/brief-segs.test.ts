import { describe, expect, it } from "vitest";
import { briefSegs, type FlowSeg } from "../desktop/renderer/src/lib/flow";

const tool = { kind: "tool", at: 1, name: "read", arg: "", status: "ok" } as const;
const long = "产物正文".repeat(100);

describe("briefSegs：推进动作的事件流不重复贴整份产物", () => {
  it("跑完后：最后只有文字没有步骤的那段（就是产物）去掉，前面的简短说明保留", () => {
    const segs: FlowSeg[] = [
      { at: 1, say: "读建表脚本", items: [tool] },
      { at: 2, say: long, items: [] },
    ];
    const r = briefSegs(segs, false);
    expect(r).toHaveLength(1);
    expect(r[0].say).toBe("读建表脚本");
  });

  it("运行中：正在写的长文字显示成「正在撰写产物」，不贴原文", () => {
    const r = briefSegs([{ at: 1, say: long, items: [] }], true);
    expect(r[0].say).toContain("正在撰写产物");
    expect(r[0].say).not.toContain("产物正文");
  });

  it("中间夹着的长说明截成一行，短说明原样保留", () => {
    const segs: FlowSeg[] = [
      { at: 1, say: long, items: [tool] },
      { at: 2, say: "再查接口", items: [tool] },
    ];
    const r = briefSegs(segs, false);
    expect(r[0].say!.length).toBeLessThan(80);
    expect(r[0].say!.endsWith("…")).toBe(true);
    expect(r[1].say).toBe("再查接口");
  });

  it("没有文字的段落原样保留", () => {
    expect(briefSegs([{ at: 1, items: [tool] }], false)).toHaveLength(1);
  });
});
