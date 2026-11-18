import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DefectWatcher } from "../desktop/main/defects";
import { dingtalkTransition, dingtalkTransitions, feishuTransition, feishuTransitions, fetchDingtalkDefects, fetchFeishuDefects, parseDefectRows, parseDingtalkTasks, resetDefectMeta } from "../desktop/main/defects-source";
import { defectKey, isClosedStatus, type Defect, type DefectsResult } from "../desktop/shared/defects";

const space = { name: "技术支持部", key: "pk1", simpleName: "wk-support" };
const field = (key: string, value: unknown) => ({ key, name: key, value });
const row = (o: { id: number; name: string; status: string; statusKey?: string; operators?: string[]; owner?: string }) => ({
  moql_field_list: [
    field("work_item_id", { long_value: o.id }),
    field("name", { string_value: o.name }),
    field("work_item_status", { key_label_value_list: [{ key: o.statusKey ?? "k", label: o.status }] }),
    field("priority", { key_label_value: { key: "p", label: "P1" } }),
    field("severity", null),
    field("owner", { user_value: { name_cn: o.owner ?? "张三", user_key: "1" } }),
    field("current_status_operator", { user_value_list: (o.operators ?? ["我"]).map(n => ({ name_cn: n })) }),
    field("start_time", { string_value: "2026-11-09" }),
    field("updated_at", { string_value: "2026-11-13" }),
  ],
});

describe("缺陷：状态判断", () => {
  it("已关闭 / 取消 / 完成算终态，未完成和已解决不算", () => {
    for (const s of ["已关闭", "CLOSED", "已完成", "已取消", "终止", "DONE"]) expect(isClosedStatus(s)).toBe(true);
    for (const s of ["OPEN", "IN PROGRESS", "RESOLVED", "未完成", "待处理", "修复中"]) expect(isClosedStatus(s)).toBe(false);
    expect(isClosedStatus("x", "closed")).toBe(true);
  });
});

describe("缺陷：解析飞书 MQL 结果", () => {
  it("取出标题、状态、优先级、提出人、时间和链接，空字段忽略", () => {
    const j = { data: { "1": [row({ id: 7162305804, name: "收不到验证码", status: "OPEN", statusKey: "Not started" })] }, list: null };
    const [d] = parseDefectRows(j, space, { key: "issue", name: "缺陷" });
    expect(d).toMatchObject({ id: "7162305804", source: "feishu", title: "收不到验证码", status: "OPEN", statusKey: "Not started", priority: "P1", reporter: "张三", assignees: ["我"], space: "技术支持部", typeKey: "issue" });
    expect(d.severity).toBeUndefined();
    expect(d.url).toBe("https://project.feishu.cn/wk-support/issue/detail/7162305804");
    expect(d.created).toBe(new Date(2026, 10, 9).getTime());
    expect(defectKey(d)).toBe("feishu:7162305804");
  });
  it("没有数据 / 结构不对时返回空", () => {
    expect(parseDefectRows({ data: {} }, space, { key: "issue", name: "缺陷" })).toEqual([]);
    expect(parseDefectRows("x", space, { key: "issue", name: "缺陷" })).toEqual([]);
    expect(parseDefectRows({ data: { "1": [{ moql_field_list: [field("name", { string_value: "没有 id" })] }] } }, space, { key: "issue", name: "缺陷" })).toEqual([]);
  });
});

describe("缺陷：解析钉钉待办", () => {
  it("跳过已完成的，取出标题、创建人、截止时间", () => {
    const j = { result: { todoCards: [{ taskId: "t1", subject: "修登录问题", creatorName: "李四", dueTime: 1_800_000_000_000 }, { taskId: "t2", subject: "已做完", done: true }, { subject: "没 id" }] } };
    const l = parseDingtalkTasks(j);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id: "t1", source: "dingtalk", title: "修登录问题", reporter: "李四", status: "待处理", due: 1_800_000_000_000 });
  });
});

// ───── 用一个假的 meegle / dws 命令行跑完整流程 ─────

let dir: string;
let fakeMeegle: string;
let fakeDws: string;
let calls: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "defects-"));
  calls = path.join(dir, "calls.log");
  fakeMeegle = path.join(dir, "meegle.cjs");
  fakeDws = path.join(dir, "dws.cjs");
  fs.writeFileSync(
    fakeMeegle,
    `
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, a.join(" ") + "\\n");
const arg = n => (a.find(x => x.startsWith("--" + n + "=")) || "").slice(n.length + 3);
const out = o => console.log(JSON.stringify(o));
const rows = ${JSON.stringify([row({ id: 1, name: "登录失败", status: "OPEN" }), row({ id: 2, name: "已经关了的", status: "已关闭" })])};
if (a[0] === "user" && a[1] === "me") out({ name_cn: "我", user_key: "9" });
else if (a[0] === "project") out({ projects: [{ name: "技术支持部", project_key: "pk1", simple_name: "wk-support" }, { name: "坏空间", project_key: "pk2", simple_name: "bad" }] });
else if (a[0] === "workitem" && a[1] === "meta-types") out({ list: [{ type_key: "story", name: "需求" }, { type_key: "issue", name: "缺陷" }] });
else if (a[0] === "workitem" && a[1] === "query") {
  const mql = arg("mql");
  if (arg("project-key") === "pk2") { out({ data: null, error: { message: "error=ErrX,message=没有权限" } }); }
  else if (!mql.includes("'我'")) { out({ data: null, error: { message: "查询条件不是当前登录人" } }); }
  else if (mql.includes("severity")) out({ data: null, error: { message: "attr label not found, projectKey:pk1, labelRequestUUID:severity, label:severity. no similar field" } });
  else out({ data: { "1": rows } });
}
else if (a[0] === "workflow" && a[1] === "list-state-transitions") {
  if (arg("work-item-id") === "99") { console.error("only state-flow work item"); process.exit(1); }
  out({ state_key: "k", state_name: "OPEN", transition: [{ id: 11, state_name: "IN PROGRESS", confirm_form: null }, { id: 12, state_name: "RESOLVED", confirm_form: [{ key: "reason" }] }] });
}
else if (a[0] === "workflow" && a[1] === "transition-state") {
  if (arg("transition-id") === "13") out({ data: null, error: { message: "error=Forbidden,message=无权流转" } });
  else out({ ok: true });
}
else out({});
`,
  );
  fs.writeFileSync(
    fakeDws,
    `
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, "dws " + a.join(" ") + "\\n");
if (a[1] === "task" && a[2] === "list") console.log(JSON.stringify({ result: { todoCards: [{ taskId: "t1", subject: "修登录", creatorName: "李四" }] } }));
else if (a[2] === "done") console.log(JSON.stringify({ success: true }));
else console.log("{}");
`,
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const mg = () => ({ bin: process.execPath, binArgs: [fakeMeegle] });

describe("缺陷：飞书拉取与流转（假 meegle）", () => {
  it("遍历空间 → 找缺陷类型 → 按当前登录人查 → 去掉已关闭的；缺字段会去掉重试；坏空间进警告", async () => {
    resetDefectMeta();
    const r = await fetchFeishuDefects(mg());
    expect(r.ok).toBe(true);
    expect(r.user).toBe("我");
    expect(r.items.map(d => d.title)).toEqual(["登录失败"]);
    expect(r.warnings?.[0]).toContain("坏空间");
    expect(r.warnings?.[0]).toContain("没有权限");
    const log = fs.readFileSync(calls, "utf8");
    expect(log).toContain("workitem meta-types --project-key=pk1");
    expect(log.split("\n").filter(l => l.startsWith("workitem query --project-key=pk1")).length).toBe(2); // 第一次带 severity 失败，去掉后成功
  });
  it("空间和类型有缓存，第二次不再重新找", async () => {
    const before = fs.readFileSync(calls, "utf8").split("\n").filter(l => l.startsWith("project search")).length;
    await fetchFeishuDefects(mg());
    const after = fs.readFileSync(calls, "utf8").split("\n").filter(l => l.startsWith("project search")).length;
    expect(after).toBe(before);
  });
  it("命令行不存在时给出原因，不抛异常", async () => {
    resetDefectMeta();
    const r = await fetchFeishuDefects({ bin: path.join(dir, "不存在的命令") });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
  const d: Defect = { id: "1", source: "feishu", title: "x", status: "OPEN", spaceKey: "pk1", typeKey: "issue" };
  it("列出能流转的状态，带表单的标出来", async () => {
    const t = await feishuTransitions(mg(), d);
    expect(t.ok).toBe(true);
    expect(t.current).toBe("OPEN");
    expect(t.items).toEqual([
      { id: "11", name: "IN PROGRESS", needsForm: undefined },
      { id: "12", name: "RESOLVED", needsForm: true },
    ]);
  });
  it("节点流程的缺陷列不出状态，给出提示", async () => {
    const t = await feishuTransitions(mg(), { ...d, id: "99" });
    expect(t.ok).toBe(false);
    expect(t.error).toBeTruthy();
  });
  it("流转：成功 / 对方拒绝时带原因 / 非法 id 不执行", async () => {
    expect(await feishuTransition(mg(), d, "11")).toEqual({ ok: true });
    const bad = await feishuTransition(mg(), d, "13");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("无权流转");
    expect((await feishuTransition(mg(), d, "1; rm -rf")).ok).toBe(false);
    const log = fs.readFileSync(calls, "utf8");
    expect(log).toContain("workflow transition-state --project-key=pk1 --work-item-id=1 --transition-id=11");
    expect(log).not.toContain("rm -rf");
  });
});

describe("缺陷：钉钉拉取与完成（假 dws）", () => {
  const dc = () => ({ bin: process.execPath, binArgs: [fakeDws] });
  it("拉未完成待办，并能标记完成", async () => {
    const r = await fetchDingtalkDefects(dc());
    expect(r.ok).toBe(true);
    expect(r.items.map(d => d.title)).toEqual(["修登录"]);
    expect(dingtalkTransitions().items).toEqual([{ id: "done", name: "标记完成" }]);
    expect(await dingtalkTransition(dc(), r.items[0], "done")).toEqual({ ok: true });
    expect((await dingtalkTransition(dc(), r.items[0], "x")).ok).toBe(false);
    expect(fs.readFileSync(calls, "utf8")).toContain("dws todo task done --task-id=t1 --status=true");
  });
});

describe("缺陷：监视器", () => {
  const mk = (id: string, status = "OPEN"): Defect => ({ id, source: "feishu", title: "问题" + id, status });
  const res = (items: Defect[], extra: Partial<DefectsResult> = {}): DefectsResult => ({ enabled: true, source: "feishu", ok: true, items, at: 1, ...extra });
  const file = () => path.join(dir, `w-${Math.random().toString(36).slice(2)}.json`);

  it("第一次只建基线（不通知、不算新）；之后来了新的才通知并标记为新，打开后清掉", async () => {
    let cur = res([mk("1")]);
    const news: Defect[][] = [];
    const w = new DefectWatcher(file(), async () => cur, undefined, i => news.push(i));
    let r = await w.refresh();
    expect(news).toEqual([]);
    expect(r.items[0].isNew).toBeUndefined();
    cur = res([mk("1"), mk("2")]);
    r = await w.refresh();
    expect(news.map(x => x.map(d => d.id))).toEqual([["2"]]);
    expect(r.items.find(d => d.id === "2")?.isNew).toBe(true);
    expect(r.items.find(d => d.id === "1")?.isNew).toBeUndefined();
    await w.refresh(); // 同样的结果不再通知
    expect(news).toHaveLength(1);
    const seen = w.markSeen()!;
    expect(seen.items.every(d => !d.isNew)).toBe(true);
  });
  it("重启后记得已通知过的，不重复弹", async () => {
    const f = file();
    const news: Defect[][] = [];
    const a = new DefectWatcher(f, async () => res([mk("1")]), undefined, i => news.push(i));
    await a.refresh();
    const b = new DefectWatcher(f, async () => res([mk("1"), mk("3")]), undefined, i => news.push(i));
    await b.refresh();
    expect(news.map(x => x.map(d => d.id))).toEqual([["3"]]);
  });
  it("取数失败保留上次的列表并带上错误；部分空间失败不当成问题消失", async () => {
    let cur = res([mk("1"), mk("2")]);
    const news: Defect[][] = [];
    const w = new DefectWatcher(file(), async () => cur, undefined, i => news.push(i));
    await w.refresh();
    cur = res([], { ok: false, error: "网络不通" });
    let r = await w.refresh();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("网络不通");
    expect(r.items.map(d => d.id)).toEqual(["1", "2"]);
    cur = res([mk("1")], { warnings: ["某空间：失败"] });
    await w.refresh();
    cur = res([mk("1"), mk("2")]);
    r = await w.refresh();
    expect(news).toEqual([]); // 2 只是暂时没取到，回来了不算新
  });
  it("没接项目管理工具：什么都不做，也不通知", async () => {
    const news: Defect[][] = [];
    const changed: DefectsResult[] = [];
    const w = new DefectWatcher(file(), async () => ({ enabled: false, ok: true, items: [], at: 1 }), r => changed.push(r), i => news.push(i));
    const r = await w.refresh();
    expect(r.enabled).toBe(false);
    expect(news).toEqual([]);
    expect(changed).toHaveLength(1);
  });
  it("并发刷新合并成一次", async () => {
    let n = 0;
    const w = new DefectWatcher(file(), async () => (n++, res([])));
    await Promise.all([w.refresh(), w.refresh(), w.refresh()]);
    expect(n).toBe(1);
  });
  it("按 key 找缺陷", async () => {
    const w = new DefectWatcher(file(), async () => res([mk("5")]));
    await w.refresh();
    expect(w.find("feishu:5")?.title).toBe("问题5");
    expect(w.find("feishu:6")).toBeUndefined();
  });
});
