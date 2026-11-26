import { describe, expect, it } from "vitest";
import { ProgressText, ReplyStream, type StreamIO } from "../src/channels/stream";

function io(opts: { id?: string | undefined; editOk?: boolean } = {}) {
  const log: string[] = [];
  const o: StreamIO = {
    send: async t => (log.push("send:" + t), "id" in opts ? opts.id : "om_1"),
    edit: async (id, t) => (log.push(`edit:${id}:${t}`), opts.editOk ?? true),
    reply: async t => void log.push("reply:" + t),
  };
  return { o, log };
}

describe("ReplyStream", () => {
  it("过程中节流编辑，最后改成最终答案", async () => {
    let now = 0;
    const { o, log } = io();
    const s = new ReplyStream(o, { minIntervalMs: 2000, now: () => now });
    expect(await s.start("处理中")).toBe(true);
    now = 500;
    s.update("a"); // 距上次不足 2s：不立刻编辑
    now = 2500;
    s.update("ab");
    await s.finish("最终");
    expect(log).toEqual(["send:处理中", "edit:om_1:ab", "edit:om_1:最终"]);
  });

  it("过程编辑有上限，最终答案不占额度", async () => {
    let now = 0;
    const { o, log } = io();
    const s = new ReplyStream(o, { minIntervalMs: 1, maxEdits: 2, now: () => now });
    await s.start("x");
    for (let i = 1; i <= 5; i++) {
      now += 10;
      s.update("t" + i);
    }
    await s.finish("done");
    expect(log.filter(l => l.startsWith("edit:"))).toEqual(["edit:om_1:t1", "edit:om_1:t2", "edit:om_1:done"]);
  });

  it("拿不到消息 id：start 返回 false，最终整条另发", async () => {
    const { o, log } = io({ id: undefined });
    const s = new ReplyStream(o);
    expect(await s.start()).toBe(false);
    await s.finish("答案");
    expect(log).toEqual(["send:⏳ 收到，正在处理…", "reply:答案"]);
  });

  it("编辑失败：最终答案整条另发", async () => {
    const { o, log } = io({ editOk: false });
    const s = new ReplyStream(o);
    await s.start("x");
    await s.finish("答案");
    expect(log.at(-1)).toBe("reply:答案");
  });

  it("超长答案：第一段编辑原消息，其余另发", async () => {
    const { o, log } = io();
    const s = new ReplyStream(o, { chunk: 10 });
    await s.start("x");
    await s.finish("aaaaaaaaaa\nbbbbbbbbbb");
    expect(log.filter(l => l.startsWith("edit:")).length).toBe(1);
    expect(log.filter(l => l.startsWith("reply:")).length).toBe(1);
  });
});

describe("ReplyStream 的卡片附加信息", () => {
  it("开头和编辑都带上 meta，最终答案多带耗时", async () => {
    let now = 1000;
    const seen: Array<{ kind: string; meta: any }> = [];
    const o: StreamIO = {
      send: async (_t, meta) => (seen.push({ kind: "send", meta }), "om_1"),
      edit: async (_id, _t, final, _failed, meta) => (seen.push({ kind: final ? "final" : "edit", meta }), true),
      reply: async () => {},
    };
    const s = new ReplyStream(o, { minIntervalMs: 1, now: () => now, meta: { title: "任务A", question: "问题" } });
    await s.start("x");
    now = 1100;
    s.setMeta({ toolCount: 2, tools: ["🔧 a", "🔧 b"] });
    s.update("进行中");
    now = 1000 + 216_000;
    await s.finish("done");
    expect(seen[0]).toEqual({ kind: "send", meta: { title: "任务A", question: "问题" } });
    expect(seen[1].meta).toMatchObject({ title: "任务A", toolCount: 2 });
    expect(seen[1].meta.ms).toBeUndefined();
    expect(seen[2]).toMatchObject({ kind: "final", meta: { title: "任务A", toolCount: 2, ms: 216_000 } });
  });
});

describe("ProgressText 的工具清单", () => {
  it("🔧 行算一次调用，✓ 不重复计，✗ 记一笔但不算次数", () => {
    const p = new ProgressText();
    p.feed({ type: "agent_progress", line: "🔧 shell {\"command\":\"ls\"}", kind: "tool" });
    p.feed({ type: "agent_progress", line: "   ✓ shell → ok", kind: "tool" });
    p.feed({ type: "agent_progress", line: "🔧 read_file {\"path\":\"a\"}", kind: "tool" });
    p.feed({ type: "agent_progress", line: "   ✗ read_file 失败：没有这个文件", kind: "tool" });
    const m = p.meta();
    expect(m.toolCount).toBe(2);
    expect(m.tools).toHaveLength(3);
    expect(m.tools?.[2]).toContain("⚠️");
  });
  it("自带 loop 的 tool_call 事件也计数；清单只留最近 40 条，总数不丢", () => {
    const p = new ProgressText();
    for (let i = 0; i < 50; i++) p.feed({ type: "tool_call", step: 1, name: `t${i}`, args: {} } as any);
    expect(p.meta().toolCount).toBe(50);
    expect(p.meta().tools).toHaveLength(40);
    expect(p.meta().tools?.[39]).toContain("t49");
  });
});

describe("ProgressText", () => {
  it("状态 + 已写出的回答", () => {
    const p = new ProgressText();
    expect(p.feed({ type: "agent_progress", line: "读取 a.ts", kind: "tool" })).toContain("🔧 读取 a.ts");
    expect(p.feed({ type: "agent_progress", line: "你好", kind: "text" })).toBe("✍️ 正在回答…\n\n你好");
    expect(p.feed({ type: "agent_progress", line: "", kind: "text" })).toBeUndefined();
  });
});
