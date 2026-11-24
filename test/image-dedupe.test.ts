import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Backend } from "../desktop/main/backend";
import { splitDuplicates } from "../desktop/renderer/src/lib/imageDup";

describe("splitDuplicates：输入框里同一张图片只留一个", () => {
  it("已经在里面的、这一批里自己重复的，都算重复", () => {
    expect(splitDuplicates(["a.png"], ["a.png", "b.png", "b.png", "c.png"])).toEqual({ fresh: ["b.png", "c.png"], dup: 2 });
  });
  it("没有重复就原样", () => {
    expect(splitDuplicates([], ["a.png", "b.png"])).toEqual({ fresh: ["a.png", "b.png"], dup: 0 });
  });
  it("空路径不算", () => {
    expect(splitDuplicates(["a.png"], ["", "b.png"])).toEqual({ fresh: ["b.png"], dup: 0 });
  });
});

describe("saveImage：同样的内容存成同一个文件", () => {
  const png = (n: number) => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, n, n, n]);
  it("贴两次同一张图，路径一样；不同的图路径不同", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "imgdup-"));
    const b = new Backend(home, { send() {} });
    const a1 = b.saveImage(png(1), "image/png");
    const a2 = b.saveImage(png(1), "image/png");
    const c = b.saveImage(png(2), "image/png");
    expect(a1.ok && a2.ok && c.ok).toBe(true);
    if (a1.ok && a2.ok && c.ok) {
      expect(a2.path).toBe(a1.path);
      expect(c.path).not.toBe(a1.path);
      expect(fs.readdirSync(path.join(home, "pasted-images"))).toHaveLength(2);
    }
  });
});
