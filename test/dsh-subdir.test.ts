import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { DshPlugins } from "../desktop/main/dsh-host";
import { foreignId, type PluginEntry } from "../desktop/shared/plugins";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const files: Record<string, string> = {
  "README.md": "多平台仓库，根目录没有 package.json",
  "plugins/claude-code/package.json": JSON.stringify({ name: "cc-thing", version: "1.0.0" }),
  "plugins/dsh/package.json": JSON.stringify({ name: "@x/multi-dsh", version: "0.3.0", dsh: {}, main: "index.js" }),
  "plugins/dsh/index.js": `exports.name = "multi"; exports.inject = ["tools"]; exports.apply = () => {};`,
  "plugins/dsh/tests/package.json": JSON.stringify({ name: "fixture", dsh: {} }),
};

const fakeGithub = (async (input: any) => {
  const url = String(input);
  if (/api\.github\.com\/repos\/o\/multi\/git\/trees\//.test(url)) return new Response(JSON.stringify({ tree: Object.keys(files).map(p => ({ path: p, type: "blob" })) }));
  const raw = /^https:\/\/raw\.githubusercontent\.com\/o\/multi\/[^/]+\/(.+)$/.exec(url);
  if (raw && files[decodeURIComponent(raw[1])] !== undefined) return new Response(files[decodeURIComponent(raw[1])]);
  return new Response("", { status: 404 });
}) as typeof fetch;

it("DSH 插件在仓库子目录里（索引没写目录）：自动找到带 dsh 字段的 package.json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sub-"));
  dirs.push(dir);
  const h = new DshPlugins({ dir, consentFile: path.join(dir, "c.json"), fetchImpl: fakeGithub });
  const pkg = "multi-dsh";
  const e = {
    key: "k",
    id: foreignId("dsh", pkg),
    name: pkg,
    kind: "dsh",
    ecosystem: "dsh",
    description: "",
    tags: [],
    source: "t",
    install: { kind: "dsh", pkg, version: "0.0.0", source: { type: "git", url: "https://github.com/o/multi", commit: "a".repeat(40) } },
  } as PluginEntry;
  expect(await h.install(e)).toBe("0.3.0");
  expect(h.installed().map(m => m.id)).toEqual([e.id]);
}, 60000);
