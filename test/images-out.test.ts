import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findReplyImages } from "../src/channels/images-out";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-out-"));
afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 临时目录偶发 EPERM */
  }
});

const mk = (name: string, ageMs = 0, bytes = 8) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
};

describe("回复里的图片路径", () => {
  it("找出本次运行里新写的图片（含中文名、反引号包着的）", () => {
    const p = mk("花果-执行器列表.png");
    expect(findReplyImages(`截图已保存：\`${p}\`。`, Date.now() - 1000)).toEqual([p]);
  });

  it("运行开始之前就有的旧文件不发", () => {
    const old = mk("old.png", 3600_000);
    expect(findReplyImages(`见 ${old}`, Date.now() - 1000)).toEqual([]);
  });

  it("不存在的、非图片的、超大的都跳过；同一个只算一次", () => {
    const ok = mk("a.jpg");
    mk("b.txt");
    const big = mk("big.png", 0, 11 * 1024 * 1024);
    const text = `${ok} ${ok} ${path.join(dir, "none.png")} ${path.join(dir, "b.txt")} ${big}`;
    expect(findReplyImages(text, Date.now() - 1000)).toEqual([ok]);
  });

  it("最多 4 张", () => {
    const ps = [1, 2, 3, 4, 5, 6].map(i => mk(`m${i}.png`));
    expect(findReplyImages(ps.join("\n"), Date.now() - 1000)).toHaveLength(4);
  });

  it("网址里的路径段、网络路径（UNC）不当成本机文件去访问", () => {
    const ok = mk("net-ok.png");
    const text = `见 https://example.com/a/b.png 和 //evil-host/share/c.png 和 \\\\evil-host\\share\\d.png 还有 ${ok}`;
    expect(findReplyImages(text, Date.now() - 1000)).toEqual([ok]);
  });
});