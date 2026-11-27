import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Guardrails, approveAll, denyAll } from "../src/core/guardrails";
import type { Tool } from "../src/core/types";
import { toHostTools } from "../src/tools/host-tools";

const mk = (name: string, risk: Tool["risk"], ran: string[]): Tool => ({
  name,
  description: `[插件 · X] ${name}`,
  risk,
  schema: z.object({ q: z.string() }),
  jsonSchema: { type: "object", properties: { q: { type: "string" } } },
  run: async a => {
    ran.push(`${name}:${a.q}`);
    return "ok:" + a.q;
  },
});

const env = (approve = denyAll) => ({ guard: new Guardrails({ policy: { read: "allow" } }), approve, root: process.cwd(), signal: new AbortController().signal });

describe("插件工具挂给外部 Agent", () => {
  it("沿用工具名、描述和 JSON Schema", () => {
    const h = toHostTools([mk("plugin__a__list", "read", [])], env());
    expect(Object.keys(h)).toEqual(["plugin__a__list"]);
    expect(h["plugin__a__list"]!.description).toContain("插件");
    expect(h["plugin__a__list"]!.inputSchema["type"]).toBe("object");
  });

  it("只读工具直接执行", async () => {
    const ran: string[] = [];
    const h = toHostTools([mk("plugin__a__list", "read", ran)], env());
    expect(await h["plugin__a__list"]!.execute({ q: "1" })).toBe("ok:1");
    expect(ran).toEqual(["plugin__a__list:1"]);
  });

  it("写工具要批准：拒绝就不执行并把原因回给 Agent", async () => {
    const ran: string[] = [];
    const h = toHostTools([mk("plugin__a__exec", "write", ran)], env(denyAll));
    expect(await h["plugin__a__exec"]!.execute({ q: "x" })).toContain("被护栏拒绝");
    expect(ran).toEqual([]);
  });

  it("写工具批准后执行", async () => {
    const ran: string[] = [];
    const h = toHostTools([mk("plugin__a__exec", "write", ran)], env(approveAll));
    expect(await h["plugin__a__exec"]!.execute({ q: "x" })).toBe("ok:x");
    expect(ran).toEqual(["plugin__a__exec:x"]);
  });

  it("参数不对回错误、不执行", async () => {
    const ran: string[] = [];
    const h = toHostTools([mk("plugin__a__list", "read", ran)], env());
    expect(await h["plugin__a__list"]!.execute({ q: 1 })).toContain("参数错误");
    expect(ran).toEqual([]);
  });
});
