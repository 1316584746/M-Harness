import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../src/core/loop";
import type { Msg, ModelAdapter } from "../src/core/types";
import { isImagePath, loadImage, loadImages, MAX_IMAGE_BYTES } from "../src/models/images";
import { anthropic } from "../src/models/anthropic";
import { openaiCompat } from "../src/models/openai-compat";

// 1x1 透明 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let dir: string;
let png: string;
let txt: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));
  png = path.join(dir, "a.png");
  txt = path.join(dir, "a.txt");
  fs.writeFileSync(png, PNG);
  fs.writeFileSync(txt, "hi");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

function stubFetch(resp: unknown) {
  const f = vi.fn(async () => new Response(JSON.stringify(resp), { status: 200 }));
  vi.stubGlobal("fetch", f);
  return f;
}

describe("loadImage", () => {
  it("读图片成 base64；非图片 / 不存在 / 太大都跳过", () => {
    expect(isImagePath("x.PNG")).toBe(true);
    expect(isImagePath("x.txt")).toBe(false);
    expect(loadImage(png)).toMatchObject({ mime: "image/png", data: PNG.toString("base64") });
    expect(loadImage(txt)).toBeUndefined();
    expect(loadImage(path.join(dir, "nope.png"))).toBeUndefined();
    const big = path.join(dir, "big.png");
    fs.writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(loadImage(big)).toBeUndefined();
    expect(loadImages([png, txt, png]).length).toBe(2);
  });
});

describe("适配器把图片发给模型", () => {
  const mk = (): Msg[] => [
    { role: "system", content: "sys" },
    { role: "user", content: "这是什么", images: [png] },
  ];

  it("OpenAI 兼容：content 变成 text + image_url（data URL）", async () => {
    const f = stubFetch({ choices: [{ message: { content: "ok" } }] });
    await openaiCompat({ id: "o", baseURL: "http://x", apiKey: "k", model: "m" }).chat(mk(), [], new AbortController().signal);
    const body = JSON.parse((f.mock.calls[0] as any)[1].body);
    expect(body.messages[1].content[0]).toEqual({ type: "text", text: "这是什么" });
    expect(body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } });
  });

  it("OpenAI 兼容：没有图片时 content 仍是纯字符串；图片读不到时退回纯文字", async () => {
    const f = stubFetch({ choices: [{ message: { content: "ok" } }] });
    const m = openaiCompat({ id: "o", baseURL: "http://x", apiKey: "k", model: "m" });
    await m.chat([{ role: "user", content: "hi" }], [], new AbortController().signal);
    await m.chat([{ role: "user", content: "hi", images: [path.join(dir, "gone.png")] }], [], new AbortController().signal);
    for (const c of f.mock.calls) expect(JSON.parse((c as any)[1].body).messages[0].content).toBe("hi");
  });

  it("Anthropic：image 块（base64）在文字前", async () => {
    const f = stubFetch({ content: [{ type: "text", text: "ok" }] });
    await anthropic({ id: "c", apiKey: "k", model: "m" }).chat(mk(), [], new AbortController().signal);
    const body = JSON.parse((f.mock.calls[0] as any)[1].body);
    expect(body.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    expect(body.messages[0].content[1]).toEqual({ type: "text", text: "这是什么" });
  });
});

describe("运行循环带图片", () => {
  it("自驱 loop：user 消息带 images，返回的历史里也保留路径（不是 base64）", async () => {
    let seen: Msg[] = [];
    const model: ModelAdapter = {
      id: "t",
      async chat(m) {
        seen = m;
        return { message: { role: "assistant", content: "看到了" } };
      },
    };
    const r = await run({ provider: { kind: "model", id: "t", adapter: model }, tools: [], system: "s", input: "看图", images: [png], root: dir });
    expect(seen.find(m => m.role === "user")).toMatchObject({ content: "看图", images: [png] });
    expect(r.messages[0]).toMatchObject({ role: "user", images: [png] });
    expect(JSON.stringify(r.messages)).not.toContain(PNG.toString("base64"));
  });

  it("委托 Agent：prompt 里列出图片路径，并把 images 交给后端", async () => {
    let got: { prompt: string; images?: string[] } | undefined;
    const backend = {
      id: "a",
      async run(i: { prompt: string; images?: string[] }) {
        got = i;
        return { text: "done" };
      },
    };
    await run({ provider: { kind: "agent", id: "a", backend: backend as any }, tools: [], system: "", input: "看图", images: [png], root: dir });
    expect(got?.images).toEqual([png]);
    expect(got?.prompt).toContain(png);
  });
});

