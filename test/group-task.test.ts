import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ApprovalGate, approvalPrompt, groupSystem, parseVerdict, type TaskGroupBinding } from "../src/channels/group-task";
import { SessionManager } from "../src/channels/session";
import type { IncomingMessage } from "../src/channels/types";
import { parseConfig } from "../src/config";
import { Runtime } from "../src/runtime";
import { startEchoLlm } from "./helpers/echo-llm";

const bind: TaskGroupBinding = { groupId: "oc_req", taskId: "t1", title: "订单退款优化", briefing: "【任务】订单退款优化\n关联仓库：\n- ms-order：D:/repo/ms-order", repos: ["ms-order"] };

describe("确认 / 取消的判断", () => {
  it("常见说法", () => {
    for (const t of ["确认", "确定", "同意", "执行", "好", "好的", "是", "可以", "y", "OK", "yes", "确认！", " 确认 "]) expect(parseVerdict(t)).toBe("yes");
    for (const t of ["取消", "拒绝", "不用", "不要", "否", "不", "算了", "n", "No"]) expect(parseVerdict(t)).toBe("no");
  });
  it("别的话不算（避免把正常提问当成确认）", () => {
    for (const t of ["确认一下这个接口的入参", "好的我看看", "可以帮我查下吗", "不知道"]) expect(parseVerdict(t)).toBeUndefined();
  });
});

describe("在群里确认改动（ApprovalGate）", () => {
  const sent: string[] = [];
  const send = async (t: string) => void sent.push(t);

  it("发起人回复「确认」→ 放行；回复「取消」→ 拒绝", async () => {
    const g = new ApprovalGate(5000);
    const p1 = g.ask("c", "ou_owner", "要写文件吗", send);
    expect(g.has("c")).toBe(true);
    expect(g.tryResolve("c", "ou_owner", "确认")).toBe(true);
    expect(await p1).toBe(true);
    expect(g.has("c")).toBe(false);

    const p2 = g.ask("c", "ou_owner", "要执行吗", send);
    expect(g.tryResolve("c", "ou_owner", "取消")).toBe(true);
    expect(await p2).toBe(false);
  });
  it("别人说「确认」不生效（但这条话被吃掉，不会当成提问）", async () => {
    const g = new ApprovalGate(5000);
    const p = g.ask("c", "ou_owner", "x", send);
    expect(g.tryResolve("c", "ou_other", "确认")).toBe(true);
    expect(g.has("c")).toBe(true);
    g.tryResolve("c", "ou_owner", "取消");
    expect(await p).toBe(false);
  });
  it("没有待确认 / 不是确认的话 → 不处理，照常当提问", () => {
    const g = new ApprovalGate(5000);
    expect(g.tryResolve("c", "ou_owner", "确认")).toBe(false);
    void g.ask("c", "ou_owner", "x", send);
    expect(g.tryResolve("c", "ou_owner", "帮我看下订单表")).toBe(false);
    g.cancel("c");
  });
  it("超时按取消", async () => {
    const g = new ApprovalGate(30);
    expect(await g.ask("c", "ou_owner", "x", send)).toBe(false);
    expect(sent.some(s => s.includes("按「取消」"))).toBe(true);
  });
  it("提示发不出去：不干等，按取消", async () => {
    const g = new ApprovalGate(5000);
    expect(await g.ask("c", "ou_owner", "x", async () => Promise.reject(new Error("net")))).toBe(false);
  });
  it("确认提示里有动作和参数", () => {
    const p = approvalPrompt({ tool: { name: "write_file" }, args: { path: "a.java" }, reason: "写文件" });
    expect(p).toContain("write_file");
    expect(p).toContain("a.java");
    expect(p).toContain("确认");
  });
});

describe("群里的系统提示", () => {
  it("带上需求说明；访客只读，主人改动要确认", () => {
    const g = groupSystem(bind, true, "基础提示");
    expect(g).toContain("基础提示");
    expect(g).toContain("订单退款优化");
    expect(g).toContain("不能改文件");
    const o = groupSystem(bind, false);
    expect(o).toContain("回复「确认」");
  });
});

describe("需求群里的提问（SessionManager）", () => {
  it("绑定了需求的群：访客的提问带「群成员提问」前缀；没绑定的群原样", async () => {
    const llm = await startEchoLlm();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-grp-"));
    const rt = new Runtime(parseConfig({ traceDir: path.join(dir, "t"), defaultProvider: "echo", providers: { echo: llm.provider } }));
    const sm = new SessionManager(rt, () => {}, { binding: id => (id === "oc_req" ? bind : undefined), repoPath: () => dir });
    const out: string[] = [];
    const mk = (chatId: string, over: Partial<IncomingMessage> = {}): IncomingMessage => ({ channel: "feishu-cli", conversationId: `feishu:${chatId}`, userId: "ou_g", text: "退款怎么算", reply: async t => void out.push(t), chatId, isGroup: true, guest: true, ...over });
    try {
      await sm.handle(mk("oc_req"));
      await sm.handle(mk("oc_other"));
      expect(out[0]).toContain("【群成员提问】退款怎么算");
      expect(out[1]).toBe("【echo】退款怎么算");
    } finally {
      await llm.close();
    }
  });

  it("不同群 / 换绑需求：上下文和会话标识互不串", async () => {
    const llm = await startEchoLlm();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-grp-"));
    const rt = new Runtime(parseConfig({ traceDir: path.join(dir, "t"), defaultProvider: "echo", providers: { echo: llm.provider } }));
    const calls: Array<{ key?: string; hist: number }> = [];
    const orig = rt.runTask.bind(rt);
    rt.runTask = (req: any) => (calls.push({ key: req.sessionKey, hist: req.history?.length ?? 0 }), orig(req));
    let taskA = "t1";
    const sm = new SessionManager(rt, () => {}, { binding: id => (id === "oc_a" ? { ...bind, taskId: taskA } : id === "oc_b" ? { ...bind, taskId: "t2" } : undefined), repoPath: () => dir });
    const ask = (chatId: string) => sm.handle({ channel: "feishu-cli", conversationId: `feishu:${chatId}`, userId: "ou_g", text: "问", chatId, isGroup: true, guest: true, reply: async () => {} });
    try {
      await ask("oc_a");
      await ask("oc_b"); // 另一个群：没有 A 群的上下文
      await ask("oc_a"); // 回 A 群：续上自己的
      taskA = "t9";
      await ask("oc_a"); // A 群换绑到别的需求：清掉
      expect(calls.map(c => c.hist)).toEqual([0, 0, 2, 0]);
      expect(calls[0].key).toBe("feishu:oc_a#t1:guest");
      expect(calls[1].key).toBe("feishu:oc_b#t2:guest");
      expect(calls[3].key).toBe("feishu:oc_a#t9:guest");
    } finally {
      await llm.close();
    }
  });

  it("群主在绑定了需求的群里说话：交给任务对话（dispatch）；接不了才在主进程答；访客不派；/stop 能中断派出去的", async () => {
    const llm = await startEchoLlm();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-grp-"));
    const rt = new Runtime(parseConfig({ traceDir: path.join(dir, "t"), defaultProvider: "echo", providers: { echo: llm.provider } }));
    const dispatched: string[] = [];
    let accept = true;
    const stops: string[] = [];
    const sm = new SessionManager(rt, () => {}, {
      binding: id => (id === "oc_req" ? bind : undefined),
      repoPath: () => dir,
      dispatch: async (b, m) => (dispatched.push(`${b.taskId}:${m.text}`), accept),
      stop: id => (stops.push(id), true),
    });
    const out: string[] = [];
    const mk = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({ channel: "feishu-cli", conversationId: "feishu:oc_req", userId: "ou_owner", text: "改一下退款", reply: async t => void out.push(t), chatId: "oc_req", isGroup: true, ...over });
    try {
      await sm.handle(mk());
      expect(dispatched).toEqual([`${bind.taskId}:改一下退款`]);
      expect(out).toEqual([]); // 回复由任务对话那边负责
      accept = false;
      await sm.handle(mk());
      expect(out.length).toBe(1); // 接不了：主进程自己答
      await sm.handle(mk({ guest: true }));
      expect(dispatched.length).toBe(2); // 访客不派
      await sm.handle(mk({ text: "/stop" }));
      expect(stops).toEqual(["oc_req"]);
    } finally {
      await llm.close();
    }
  });

  it("回复方式：任务选流式 → 走 stream；整条发送 → 不走；跟随全局 → 看全局默认", async () => {
    const llm = await startEchoLlm();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-grp-"));
    const rt = new Runtime(parseConfig({ traceDir: path.join(dir, "t"), defaultProvider: "echo", providers: { echo: llm.provider } }));
    let reply: "global" | "stream" | "whole" = "stream";
    let global: "stream" | "whole" = "stream";
    const sm = new SessionManager(rt, () => {}, { binding: id => (id === "oc_req" ? { ...bind, reply } : undefined), repoPath: () => dir, defaultReply: () => global });
    const run = async () => {
      const log: string[] = [];
      await sm.handle({
        channel: "feishu-cli", conversationId: "feishu:oc_req", userId: "ou_g", text: "退款怎么算", chatId: "oc_req", isGroup: true, guest: true,
        reply: async t => void log.push("reply:" + t),
        stream: async () => ({ update: () => {}, finish: async t => void log.push("stream:" + t) }),
      });
      return log;
    };
    try {
      expect((await run())[0]).toMatch(/^stream:/);
      reply = "whole";
      expect((await run())[0]).toMatch(/^reply:/);
      reply = "global";
      global = "whole";
      expect((await run())[0]).toMatch(/^reply:/);
      global = "stream";
      expect((await run())[0]).toMatch(/^stream:/);
    } finally {
      await llm.close();
    }
  });
});
