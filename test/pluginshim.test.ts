import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { PLUGIN_SHIM } from "../desktop/main/pluginshim";

/** 在一个假的 iframe 环境里跑注入脚本，模拟宿主页面发来的消息 */
function boot() {
  const listeners: ((e: unknown) => void)[] = [];
  const posted: Record<string, unknown>[] = [];
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  const win: Record<string, unknown> = {
    addEventListener: (_: string, f: (e: unknown) => void) => listeners.push(f),
    parent,
  };
  const root = { setAttribute() {}, style: { setProperty() {} } };
  const ctx = vm.createContext({ window: win, parent, document: { documentElement: root }, Uint8Array, Promise, Object, atob, btoa, String, Error });
  vm.runInContext(PLUGIN_SHIM, ctx);
  const send = (m: Record<string, unknown>) => listeners.forEach(f => f({ data: { __dbx: 1, ...m }, source: parent }));
  return { api: win.dbxPlugin as any, send, posted };
}

describe("插件界面的注入脚本", () => {
  it("插件后台的事件和二进制数据分别送到 onEvent / onBinary（终端输出靠它）", () => {
    const { api, send } = boot();
    const ev: unknown[] = [];
    const bin: { channel: string; data: Uint8Array }[] = [];
    api.onEvent((e: unknown) => ev.push(e));
    api.onBinary((b: { channel: string; data: Uint8Array }) => bin.push(b));
    send({ kind: "event", method: "ssh/session/state", params: { a: 1 } });
    send({ kind: "binary", channel: "ssh/terminal/out/s1", data: new Uint8Array([1, 2, 3]) });
    expect(ev).toEqual([{ method: "ssh/session/state", params: { a: 1 } }]);
    expect(bin.length).toBe(1);
    expect(bin[0].channel).toBe("ssh/terminal/out/s1");
    expect([...bin[0].data]).toEqual([1, 2, 3]);
  });

  it("二进制数据不会误进 onEvent，取消订阅后不再收到", () => {
    const { api, send } = boot();
    let n = 0;
    const off = api.onBinary(() => n++);
    let evN = 0;
    api.onEvent(() => evN++);
    send({ kind: "binary", channel: "c", data: new Uint8Array([1]) });
    off();
    send({ kind: "binary", channel: "c", data: new Uint8Array([1]) });
    expect(n).toBe(1);
    expect(evN).toBe(0);
  });

  it("decodeBase64 / encodeBase64 互逆", () => {
    const { api } = boot();
    const bytes = new Uint8Array([0, 1, 200, 255, 10]);
    const s = api.encodeBase64(bytes);
    expect(s).toBe(Buffer.from(bytes).toString("base64"));
    expect([...api.decodeBase64(s)]).toEqual([...bytes]);
  });

  it("没有的能力不提供（插件靠它决定显不显示按钮），复制 / 剪贴板走宿主", () => {
    const { api, posted } = boot();
    expect(api.openWorkbench).toBeUndefined();
    expect(api.executeCommand).toBeUndefined();
    void api.copy("hi");
    void api.clipboard.readText();
    expect(posted.filter(p => p.kind === "request").map(p => p.method)).toEqual(["host.clipboard.writeText", "host.clipboard.readText"]);
  });

  it("sendBinary 走宿主的 host.sendBinary", () => {
    const { api, posted } = boot();
    void api.sendBinary("ssh/terminal/in/s1", new Uint8Array([97]));
    const req = posted.find(p => p.kind === "request");
    expect(req).toMatchObject({ method: "host.sendBinary", params: { channel: "ssh/terminal/in/s1" } });
  });
});
