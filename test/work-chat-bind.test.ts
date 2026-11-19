import { describe, expect, it } from "vitest";
import { explainCliError, inspectChat, parseChatRef } from "../src/tools/work-chat";

describe("绑定已有群", () => {
  it("认出群 ID：直接填 / 贴群链接", () => {
    expect(parseChatRef(" oc_f5c0f99f25c6aa2dabe1f40ff64afae5 ")).toBe("oc_f5c0f99f25c6aa2dabe1f40ff64afae5");
    expect(parseChatRef("https://applink.feishu.cn/client/chat/open?openChatId=oc_abc123")).toBe("oc_abc123");
    expect(parseChatRef("随便写点什么")).toBeUndefined();
  });

  it("群 ID 格式不对直接拒绝，不去调 lark-cli", async () => {
    const r = await inspectChat({ bin: "definitely-not-a-real-bin" }, "oc_bad id");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("格式");
  });
});

describe("建群失败的原因", () => {
  it("缺权限：告诉用户怎么授权", () => {
    const out = JSON.stringify({ ok: false, error: { type: "authorization", message: "missing required scope(s): im:chat:create_by_user", missing_scopes: ["im:chat:create_by_user"] } });
    const m = explainCliError(out, "");
    expect(m).toContain("im:chat:create_by_user");
    expect(m).toContain("lark-cli auth login");
  });

  it("其他错误：给 lark-cli 的原话", () => {
    expect(explainCliError(JSON.stringify({ error: { message: "name too long" } }), "")).toBe("name too long");
    expect(explainCliError("", "boom\n  bad")).toBe("boom bad");
  });
});
