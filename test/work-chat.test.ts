import { describe, expect, it } from "vitest";
import { chatQueries, fetchWorkItemChat, parseGroupField, spaceOf } from "../src/tools/work-chat";

describe("需求群", () => {
  it("自动拉群：读出群 id 和拉群方式", () => {
    const j = { work_item_fields: [{ key: "name", value: "x" }, { key: "group_type", name: "拉群方式选择", value: { group_id: "oc_14d23013bdce38f5d9945f6acbb0fe82", label: "自动拉群" } }] };
    expect(parseGroupField(j)).toEqual({ found: true, groupId: "oc_14d23013bdce38f5d9945f6acbb0fe82", how: "自动拉群" });
  });

  it("不拉群：有字段但没有群 id", () => {
    const j = { work_item_fields: [{ key: "group_type", value: { label: "不拉群" } }] };
    expect(parseGroupField(j)).toEqual({ found: true, groupId: undefined, how: "不拉群" });
  });

  it("没有这个字段 / 群 id 格式不对都不当成有群", () => {
    expect(parseGroupField({ work_item_fields: [] }).found).toBe(false);
    expect(parseGroupField("oops").found).toBe(false);
    expect(parseGroupField({ work_item_fields: [{ key: "group_type", value: { group_id: "../etc", label: "x" } }] }).groupId).toBeUndefined();
  });

  it("按需求名搜群：括号里的关键词和正文都会作为搜索词", () => {
    expect(chatQueries("【数英满班率】组班")).toEqual(["【数英满班率】组班", "数英满班率", "数英满班率 组班"]);
    expect(chatQueries("x")).toEqual([]);
  });

  it("项目空间：优先 project_key，没有就从需求链接取空间简称", () => {
    expect(spaceOf("67bd99b84b71ca10c5256428", undefined)).toBe("67bd99b84b71ca10c5256428");
    expect(spaceOf(undefined, "https://project.feishu.cn/wk-dm/story/detail/6918237580?tabKey=detail")).toBe("wk-dm");
    expect(spaceOf(undefined, "https://example.com/a/b")).toBeUndefined();
    expect(spaceOf("bad key;", undefined)).toBeUndefined();
  });

  it("任务上没记空间：用设置里的默认空间去查，没有默认空间才报错", async () => {
    // 假的 meegle（用 node 代替）：不管收到什么都回一个空对象，只看有没有走到查询这一步
    const fp = { bin: process.execPath, binArgs: ["-e", "console.log('{}')", "--"], timeoutSec: 10, write: false } as never;
    const none = await fetchWorkItemChat(fp, undefined, { wid: "123" });
    expect(none).toMatchObject({ ok: false });
    expect((none as { error?: string }).error).toContain("默认空间");
    const withDefault = await fetchWorkItemChat({ ...(fp as object), defaultSpace: { key: "67bd99b84b71ca10c5256428" } } as never, undefined, { wid: "123" });
    expect((withDefault as { error?: string }).error ?? "").not.toContain("不知道需求在哪个飞书项目空间");
  });
});