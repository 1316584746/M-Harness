import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { TaskGroupBinding } from "../src/channels/group-task";
import { SessionManager } from "../src/channels/session";
import type { IncomingMessage } from "../src/channels/types";
import { parseConfig } from "../src/config";
import { Runtime } from "../src/runtime";
import { startEchoLlm } from "./helpers/echo-llm";

const task = (id: string, title: string, repos: string[] = []): TaskGroupBinding => ({ groupId: "", taskId: id, title, briefing: `【任务】${title}`, repos });

async function setup(tasks: () => TaskGroupBinding[], over: { accept?: () => boolean } = {}) {
  const llm = await startEchoLlm();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-focus-"));
  const rt = new Runtime(parseConfig({ traceDir: path.join(dir, "t"), defaultProvider: "echo", providers: { echo: llm.provider } }));
  const dispatched: string[] = [];
  const stops: string[] = [];
  const sm = new SessionManager(rt, () => {}, {
    binding: () => undefined,
    repoPath: () => dir,
    tasks,
    dispatch: async (b, m) => (dispatched.push(`${b.taskId}|${b.groupId}|${m.text}`), over.accept ? over.accept() : true),
    stop: id => (stops.push(id), true),
  });
  const out: string[] = [];
  const say = (text: string, o: Partial<IncomingMessage> = {}) =>
    sm.handle({ channel: "feishu-cli", conversationId: "feishu:dm1", userId: "ou_owner", text, reply: async t => void out.push(t), chatId: "dm1", ...o });
  return { say, out, dispatched, stops, close: () => llm.close() };
}

describe("飞书里 /任务：列出、选定、围绕任务对话、退出", () => {
  const all = [task("t1", "订单退款优化", ["ms-order"]), task("t2", "排课报表"), task("t3", "Python 应用学习")];

  it("/任务 列出清单；回复编号选定；之后的话全交给这个任务；/退出 结束后恢复普通对话", async () => {
    const h = await setup(() => all);
    try {
      await h.say("任务");
      expect(h.out[0]).toContain("1. 订单退款优化（ms-order）");
      expect(h.out[0]).toContain("3. Python 应用学习");
      expect(h.out[0]).toContain("「退出」");
      await h.say("2");
      expect(h.out[1]).toContain("已选定任务「排课报表」");
      await h.say("看下今天的排课");
      await h.say("再补一条");
      expect(h.dispatched).toEqual(["t2|dm1|看下今天的排课", "t2|dm1|再补一条"]);
      // 选定期间数字也是对话内容，不会误当成选编号
      await h.say("3");
      expect(h.dispatched[2]).toBe("t2|dm1|3");
      await h.say("退出");
      expect(h.out[h.out.length - 1]).toContain("已退出任务「排课报表」");
      await h.say("普通问题");
      expect(h.dispatched.length).toBe(3); // 退出后不再派给任务
      expect(h.out[h.out.length - 1]).toBe("【echo】普通问题");
    } finally {
      await h.close();
    }
  });

  it("不带斜杠：「任务」「我的任务」「任务 2」「退出任务」；整条等于才算，正常提问不被劫持", async () => {
    const h = await setup(() => all);
    try {
      await h.say("退出"); // 没选定任务时，「退出」只是一句普通话
      expect(h.out[0]).toBe("【echo】退出");
      await h.say("任务进度怎么样");
      expect(h.out[1]).toBe("【echo】任务进度怎么样");
      expect(h.dispatched).toEqual([]);
      await h.say("我的任务");
      expect(h.out[2]).toContain("进行中的任务共 3 个");
      await h.say("任务 2");
      expect(h.out[3]).toContain("已选定任务「排课报表」");
      await h.say("退出任务");
      expect(h.out[4]).toContain("已退出任务「排课报表」");
      await h.say("任务2");
      expect(h.out[5]).toContain("已选定任务「排课报表」");
      await h.say("任务"); // 选定期间再发「任务」= 重新列清单（可换一个）
      expect(h.out[6]).toContain("👉");
    } finally {
      await h.close();
    }
  });

  it("没列清单时回复数字不当选择；清单作废后（回了别的话）数字也不选", async () => {
    const h = await setup(() => all);
    try {
      await h.say("1");
      expect(h.dispatched).toEqual([]);
      await h.say("/任务");
      await h.say("先问个别的");
      await h.say("2");
      expect(h.dispatched).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("全角斜杠、/任务 数字、/任务 关键字（唯一命中直接选；多个命中再列；没有就说没有）", async () => {
    const h = await setup(() => all);
    try {
      await h.say("／任务 3");
      expect(h.out[0]).toContain("已选定任务「Python 应用学习」");
      await h.say("/任务 排课");
      expect(h.out[1]).toContain("已选定任务「排课报表」");
      await h.say("/任务 优");
      expect(h.out[2]).toContain("已选定任务「订单退款优化」");
      await h.say("/任务 不存在的");
      expect(h.out[3]).toContain("没有标题里带");
      await h.say("/任务 8");
      expect(h.out[4]).toContain("没有第 8 项");
      await h.say("/exit");
      await h.say("/任务 学");
      expect(h.out[h.out.length - 1]).toContain("已选定任务「Python 应用学习」");
    } finally {
      await h.close();
    }
  });

  it("没有任务：提示打开桌面端；没选定时 /退出 不报错；任务被删 / 完成：自动退出并说明", async () => {
    let list: TaskGroupBinding[] = [];
    const h = await setup(() => list);
    try {
      await h.say("/任务");
      expect(h.out[0]).toContain("还没有进行中的任务");
      await h.say("/退出");
      expect(h.out[1]).toContain("当前没有选定任务");
      list = all;
      await h.say("/任务 2");
      list = [all[0]];
      await h.say("还在吗");
      expect(h.out[h.out.length - 1]).toContain("已经不在进行中");
      expect(h.dispatched).toEqual([]);
      await h.say("普通问题");
      expect(h.out[h.out.length - 1]).toBe("【echo】普通问题");
    } finally {
      await h.close();
    }
  });

  it("桌面端接不了：说明原因，保持选定；访客不能用；/stop 照常中断", async () => {
    let ok = false;
    const h = await setup(() => all, { accept: () => ok });
    try {
      await h.say("/任务 1");
      await h.say("在吗");
      expect(h.out[h.out.length - 1]).toContain("没能交给任务「订单退款优化」");
      ok = true;
      await h.say("在吗");
      expect(h.dispatched.length).toBe(2);
      await h.say("/stop");
      expect(h.stops).toEqual(["dm1"]);
      await h.say("/任务", { guest: true, isGroup: true, conversationId: "feishu:g" });
      expect(h.out[h.out.length - 1]).toContain("只有机器人的主人能用");
    } finally {
      await h.close();
    }
  });

  it("群里已绑定需求：/任务 提示不用选，且选定不影响绑定", async () => {
    const llm = await startEchoLlm();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-focus-"));
    const rt = new Runtime(parseConfig({ traceDir: path.join(dir, "t"), defaultProvider: "echo", providers: { echo: llm.provider } }));
    const sm = new SessionManager(rt, () => {}, { binding: id => (id === "oc_req" ? task("tb", "已绑定的需求") : undefined), repoPath: () => dir, tasks: () => all });
    const out: string[] = [];
    try {
      await sm.handle({ channel: "feishu-cli", conversationId: "feishu:oc_req", userId: "ou_owner", text: "/任务", reply: async t => void out.push(t), chatId: "oc_req", isGroup: true });
      expect(out[0]).toContain("已经绑定了任务「已绑定的需求」");
    } finally {
      await llm.close();
    }
  });
});
