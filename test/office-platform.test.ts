import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { customOfficePrompt } from "../src/prompt/office";
import { activePlatform, setPlatform } from "../desktop/renderer/src/lib/office";

const base = () => JSON.parse(JSON.stringify({ channels: {}, integrations: {} }));

describe("办公集成：同一时间只启用一个平台", () => {
  it("没配置 → 都没启用；老配置按已有设置推断", () => {
    expect(activePlatform(base())).toBeNull();
    expect(activePlatform({ channels: { larkCli: { bin: "lark-cli" } } })).toBe("feishu");
    expect(activePlatform({ integrations: { feishuProject: {} } })).toBe("feishu");
    expect(activePlatform({ integrations: { dingtalkProject: {} } })).toBe("dingtalk");
    expect(activePlatform({ office: { active: "custom" } })).toBe("custom");
  });

  it("启用飞书：建出默认的消息通道和项目配置，并且只有它启用", () => {
    const c = base();
    setPlatform(c, "feishu");
    expect(c.office.active).toBe("feishu");
    expect(c.channels.larkCli).toEqual({ bin: "lark-cli", allowUsers: [] });
    expect(c.integrations.feishuProject).toEqual({ bin: "meegle", write: true });
    expect(c.integrations.dingtalkProject).toBeUndefined();
  });

  it("切到钉钉：飞书配置收进 stash（不丢），再切回来原样恢复", () => {
    const c = base();
    setPlatform(c, "feishu");
    c.channels.larkCli.allowUsers = ["ou_abc"];
    c.integrations.feishuProject.defaultSpace = { key: "s1", name: "空间" };
    c.integrations.feishuProject.write = true;

    setPlatform(c, "dingtalk");
    expect(activePlatform(c)).toBe("dingtalk");
    expect(c.channels.larkCli).toBeUndefined();
    expect(c.integrations.feishuProject).toBeUndefined();
    expect(c.integrations.dingtalkProject).toEqual({ write: false });
    expect(c.office.stash.feishu["channels.larkCli"].allowUsers).toEqual(["ou_abc"]);

    c.integrations.dingtalkProject.write = true;
    setPlatform(c, "feishu");
    expect(c.channels.larkCli.allowUsers).toEqual(["ou_abc"]);
    expect(c.integrations.feishuProject).toMatchObject({ write: true, defaultSpace: { key: "s1" } });
    expect(c.integrations.dingtalkProject).toBeUndefined();
    expect(c.office.stash.dingtalk["integrations.dingtalkProject"]).toEqual({ write: true });
  });

  it("切到自定义：飞书、钉钉的配置都收起来；全部关闭后没有任何平台启用", () => {
    const c = base();
    setPlatform(c, "feishu");
    setPlatform(c, "custom");
    expect(activePlatform(c)).toBe("custom");
    expect(c.channels.larkCli).toBeUndefined();
    expect(c.integrations.feishuProject).toBeUndefined();
    setPlatform(c, null);
    expect(activePlatform(c)).toBeNull();
    expect(c.office.active).toBeUndefined();
  });

  it("老配置里飞书通道和钉钉项目同时存在：启用谁就只留谁", () => {
    const c: any = { channels: { larkCli: { bin: "lark-cli", allowUsers: ["ou_1"] } }, integrations: { dingtalkProject: { write: true } } };
    setPlatform(c, "dingtalk");
    expect(c.channels.larkCli).toBeUndefined();
    expect(c.integrations.dingtalkProject).toEqual({ write: true });
    expect(c.office.stash.feishu["channels.larkCli"].allowUsers).toEqual(["ou_1"]);
  });

  it("全部都关、也没有暂存时，不留空的 office 字段", () => {
    const c = base();
    setPlatform(c, null);
    expect(c.office).toBeUndefined();
  });
});

describe("配置与提示词", () => {
  it("office 字段能通过配置校验", () => {
    const c = parseConfig({ office: { active: "custom", custom: { name: "公司 OA", instructions: "走 mcp__oa__*" }, stash: { feishu: { "channels.larkCli": { bin: "x" } } } } });
    expect(c.office.active).toBe("custom");
    expect(() => parseConfig({ office: { active: "wechat" } })).toThrow();
  });

  it("只有启用「自定义」且写了说明，才把说明放进系统提示", () => {
    const mk = (o: any) => parseConfig({ office: o }).office;
    expect(customOfficePrompt(mk({ active: "custom", custom: { name: "公司 OA", instructions: "请假走 OA" } }))).toBe("【办公集成：公司 OA】\n请假走 OA");
    expect(customOfficePrompt(mk({ active: "custom", custom: { instructions: "x" } }))).toContain("自定义办公系统");
    expect(customOfficePrompt(mk({ active: "feishu", custom: { instructions: "x" } }))).toBe("");
    expect(customOfficePrompt(mk({ active: "custom", custom: { instructions: "  " } }))).toBe("");
    expect(customOfficePrompt(mk({}))).toBe("");
  });
});
