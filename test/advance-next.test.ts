import { describe, expect, it } from "vitest";
import { advanceNextTool, parseAdvanceArgs } from "../src/tools/advance-next";
import { MAX_AUTO_ADVANCE, verifyAdvance, type AdvanceCheckInput } from "../desktop/renderer/src/lib/advance";

describe("advance_next 工具", () => {
  it("缺 user_words / action 时返回错误、不登记", async () => {
    const got: unknown[] = [];
    const t = advanceNextTool(r => got.push(r));
    expect(JSON.parse(await t.execute({ action: "review" })).ok).toBe(false);
    expect(JSON.parse(await t.execute({ user_words: "做完复核" })).ok).toBe(false);
    expect(got).toHaveLength(0);
  });

  it("参数齐全就登记并提示不要自己做下一步", async () => {
    const got: unknown[] = [];
    const t = advanceNextTool(r => got.push(r));
    const out = JSON.parse(await t.execute({ user_words: " 做完复核 ", action: "review", instruction: "重点看并发" }));
    expect(out.ok).toBe(true);
    expect(got).toEqual([{ action: "review", instruction: "重点看并发", userWords: "做完复核" }]);
  });

  it("parseAdvanceArgs：非字符串字段当空处理", () => {
    expect(typeof parseAdvanceArgs({ user_words: 1, action: "x" })).toBe("string");
  });
});

describe("verifyAdvance 授权核对", () => {
  const base: AdvanceCheckInput = {
    action: "review",
    userWords: "改完再复核一遍",
    userTexts: ["把这个接口改一下，改完再复核一遍。"],
    stepIds: ["plan", "build", "review", "ship", "dev"],
    blocked: {},
    chain: 0,
  };

  it("用户真说过 → 放行（忽略标点和空格）", () => {
    expect(verifyAdvance(base)).toEqual({ ok: true });
  });

  it("引用的话用户没说过 → 拒绝", () => {
    expect(verifyAdvance({ ...base, userWords: "直接上线" }).ok).toBe(false);
  });

  it("只在模板里出现、不在用户自己输入里 → 拒绝", () => {
    expect(verifyAdvance({ ...base, userTexts: [] }).ok).toBe(false);
  });

  it("不存在的步骤 / 被阻塞的步骤 → 拒绝", () => {
    expect(verifyAdvance({ ...base, action: "nope" }).ok).toBe(false);
    const r = verifyAdvance({ ...base, action: "dev", userWords: "改完再复核一遍联调", userTexts: ["改完再复核一遍联调"], blocked: { dev: "没配联调分支" } });
    expect(r).toEqual({ ok: false, reason: "没配联调分支" });
  });

  it("对外有副作用的步骤必须点名：说「做完复核」不能顺手提测", () => {
    expect(verifyAdvance({ ...base, action: "ship" }).ok).toBe(false);
    expect(verifyAdvance({ ...base, action: "ship", userWords: "改完直接提测", userTexts: ["改完直接提测"] })).toEqual({ ok: true });
  });

  it("连续自动推进有上限", () => {
    expect(verifyAdvance({ ...base, chain: MAX_AUTO_ADVANCE }).ok).toBe(false);
    expect(verifyAdvance({ ...base, chain: MAX_AUTO_ADVANCE - 1 }).ok).toBe(true);
  });

  it("原话太短不算数", () => {
    expect(verifyAdvance({ ...base, userWords: "。" }).ok).toBe(false);
  });
});
