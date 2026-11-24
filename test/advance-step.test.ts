import { describe, expect, it } from "vitest";
import { blockedSteps, builtinSteps, composeStep, moveItem, skillTemplate, templateOf, visibleSteps } from "../desktop/renderer/src/lib/actionSteps";

describe("推进任务：合成要发出去的话", () => {
  it("模板里有 {{input}}：替换成指令", () => {
    expect(composeStep({ prompt: "请翻译：\n\n{{input}}" }, " hello ")).toBe("请翻译：\n\nhello");
  });
  it("模板里没有 {{input}}：指令接在后面；没有指令就只发模板", () => {
    expect(composeStep({ prompt: "做复核" }, "重点看边界")).toBe("做复核\n\n重点看边界");
    expect(composeStep({ prompt: "做复核" }, "")).toBe("做复核");
  });
  it("没选下一步：只发指令；都没有就是空（不能推进）", () => {
    expect(composeStep(null, "  直接做  ")).toBe("直接做");
    expect(composeStep(null, " ")).toBe("");
  });
});

describe("动作列表：内置顺序 / 显隐", () => {
  it("默认五个内置步骤都显示", () => {
    expect(builtinSteps({}).map(b => b.id)).toEqual(["analysis", "plan", "build", "review", "dev", "ship", "release"]);
    expect(visibleSteps({}).builtins).toHaveLength(7);
  });
  it("按设置里的顺序排，隐藏的不进推进任务", () => {
    const cfg = { actionPrefs: { order: ["review", "plan"], hidden: ["build"] }, actions: [{ id: "a", name: "A", prompt: "p" }, { id: "b", name: "B", prompt: "q", hidden: true }] };
    expect(builtinSteps(cfg).map(b => b.id)).toEqual(["review", "plan", "analysis", "build", "dev", "ship", "release"]);
    const v = visibleSteps(cfg);
    expect(v.builtins.map(b => b.id)).toEqual(["review", "plan", "analysis", "dev", "ship", "release"]);
    expect(v.custom.map(a => a.id)).toEqual(["a"]);
  });
  it("moveItem 换位，越界不动", () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });
});

describe("自带动作：提示词文件", () => {
  const vars = { taskTitle: "导出报表", taskId: "t1", repoPath: "D:/repo/web" };
  const steps = builtinSteps({});
  it("每个自带动作都是 共享规范 + 动作文件，并带文件名", () => {
    for (const s of steps) {
      expect(s.file).toMatch(/^action-.+\.md$/);
      expect(s.prompt).toContain("跨动作共享规范");
      expect(s.prompt).toContain("## 本次指令");
    }
  });
  it("发送时占位符都被替换，不留 {{...}}", () => {
    for (const s of steps) {
      const out = composeStep(s, "只看登录页", vars);
      expect(out).not.toMatch(/\{\{/);
      expect(out).toContain("导出报表");
      expect(out).toContain("D:/repo/web");
      expect(out).toContain("只看登录页");
    }
  });
  it("没写指令：用默认一句话，不空着", () => {
    expect(composeStep(steps[0], "", vars)).toContain("没有额外指令");
  });
  it("出方案和复核明确不改代码，改代码不提交", () => {
    const by = (id: string) => steps.find(s => s.id === id)!.prompt;
    expect(by("plan")).toContain("不改任何文件");
    expect(by("review")).toContain("不改任何文件");
    expect(by("build")).toContain("不提交、不推送");
  });
  it("联调 / 提测：要用户确认才推送，不强推，不把目标分支合进 feature", () => {
    const by = (id: string) => steps.find(s => s.id === id)!.prompt;
    for (const id of ["dev", "ship"]) {
      expect(by(id)).toContain("绝不把");
      expect(by(id)).toContain("不强推");
      expect(by(id)).toContain("没确认");
    }
    expect(by("dev")).toContain("branches.integration");
    expect(by("ship")).toContain("branches.test");
  });
  it("方案设计：按团队模板分章（一到八），含库表 / 接口 / 灰度 / 配置与分支", () => {
    const p = steps.find(s => s.id === "plan")!.prompt;
    for (const k of ["一. 需求背景 & PRD", "二. 数据库设计", "三. 接口逻辑", "四. 变更事项", "五. 数据清洗", "六. 灰度方案", "七. 风险点 & 解决方案", "八. 增加配置 & 分支", "8.2 服务分支", "不改任何文件"]) expect(p).toContain(k);
  });
  it("改过的内置提示词：只换动作自己的那份，共享规范不变；和默认一样 / 空的不算改过", () => {
    const cfg = { actionPrefs: { overrides: { plan: { body: "# 我的方案模板\n{{input}}" }, build: { body: "  " } } } };
    const by = (id: string) => builtinSteps(cfg).find(b => b.id === id)!;
    expect(by("plan").edited).toBe(true);
    expect(by("plan").prompt).toContain("跨动作共享规范");
    expect(by("plan").prompt).toContain("# 我的方案模板");
    expect(by("plan").prompt).not.toContain("八. 增加配置");
    expect(by("plan").defaultBody).toContain("八. 增加配置");
    expect(by("build").edited).toBe(false);
    expect(builtinSteps({ actionPrefs: { overrides: { plan: { body: by("plan").defaultBody } } } }).find(b => b.id === "plan")!.edited).toBe(false);
    expect(visibleSteps(cfg).builtins.find(b => b.id === "plan")!.prompt).toContain("# 我的方案模板");
  });
  it("上线检查：只读，覆盖 xxl-job / MQ / 数据库 / 配置中心 / 机器配置，不泄露密钥", () => {
    const p = steps.find(s => s.id === "release")!.prompt;
    for (const k of ["xxl-job", "MQ", "数据库", "Nacos", "机器", "不改任何文件", "绝不把密码"]) expect(p).toContain(k);
    expect(p).toContain("branches.base");
  });
  it("自定义动作没写指令仍然不带默认句", () => {
    expect(composeStep({ prompt: "做周报：{{input}}" }, "", vars)).toBe("做周报：");
  });
});

describe("自定义动作：绑定技能 + 产出要求", () => {
  const a = { prompt: "", skill: "perf-audit", output: "输出：慢点位置和建议" };
  it("模板里写明技能名、产出要求和指令位置", () => {
    const t = skillTemplate({ skill: "perf-audit", output: "输出：慢点位置和建议" });
    expect(t).toContain("技能「perf-audit」");
    expect(t).toContain("## 产出要求");
    expect(t).toContain("输出：慢点位置和建议");
    expect(t).toContain("{{input}}");
  });
  it("没写产出要求就不带这一段", () => {
    expect(skillTemplate({ skill: "x" })).not.toContain("产出要求");
  });
  it("绑了技能就不看 prompt；没绑才用 prompt", () => {
    expect(templateOf({ prompt: "旧的", skill: "x" })).toContain("技能「x」");
    expect(templateOf({ prompt: "自己写的" })).toBe("自己写的");
  });
  it("推进时指令替换进去，没写指令用默认句", () => {
    expect(composeStep(a, "只看首页")).toContain("只看首页");
    expect(composeStep(a, "")).toContain("没有额外指令");
    expect(composeStep(a, "x")).not.toMatch(/\{\{/);
  });
});

describe("推进任务：联调要有联调分支才能选", () => {
  const cfg = { repos: { web: { branches: { integration: "develop" } }, api: { branches: { test: "test" } } } };
  it("关联的仓库里有一个配了联调分支就放行", () => {
    expect(blockedSteps(cfg, ["api", "web"])).toEqual({});
  });
  it("都没配：联调置灰并说明原因；没关联仓库也一样", () => {
    expect(blockedSteps(cfg, ["api"]).dev).toContain("联调分支");
    expect(blockedSteps(cfg, []).dev).toContain("关联");
  });
  it("提测不拦（没配测试分支会回退到 test）", () => {
    expect(blockedSteps(cfg, ["api"]).ship).toBeUndefined();
  });
});
