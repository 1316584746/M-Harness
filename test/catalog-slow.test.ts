import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { DbxBridge } from "../desktop/main/dbx";

const index = (name: string) => ({ format: 1, plugins: [{ name, versions: [{ version: "1.0.0", source: { type: "npm" } }] }] });

it("某个仓库读得太慢：先显示别的仓库的插件，慢的在后台读完进缓存，再刷新就有了", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(r => (release = r));
  const f = (async (u: any) => {
    const url = String(u);
    if (url === "https://fast.example/index.json") return new Response(JSON.stringify(index("fast-one")));
    if (url === "https://slow.example/index.json") {
      await gate;
      return new Response(JSON.stringify(index("slow-one")));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const b = new DbxBridge(f, {
    repoDeadlineMs: 150,
    repos: () => [
      { id: "slow", name: "慢仓库", url: "https://slow.example/index.json", enabled: true },
      { id: "fast", name: "快仓库", url: "https://fast.example/index.json", enabled: true },
    ],
    localDir: path.join(os.tmpdir(), "catalog-slow-plugins"),
  });
  const t0 = Date.now();
  const first = await b.catalogReport(true);
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(first.entries.map(e => e.id)).toEqual(["dsh:fast-one"]);
  expect(first.errors).toHaveLength(1);
  expect(first.errors[0].error).toMatch(/读取太慢/);

  release!();
  await new Promise(r => setTimeout(r, 50));
  const second = await b.catalogReport(false);
  expect(second.errors).toEqual([]);
  expect(second.entries.map(e => e.id).sort()).toEqual(["dsh:fast-one", "dsh:slow-one"]);
});
