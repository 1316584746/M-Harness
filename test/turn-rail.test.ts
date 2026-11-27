import { describe, expect, it } from "vitest";
import { activeIndex, plainSnippet, railItems, type RailTurn } from "../desktop/renderer/src/lib/turnRail";

const u = (id: string, text: string): RailTurn => ({ id, role: "user", text });
const a = (id: string, text: string, status: string = "done"): RailTurn => ({ id, role: "assistant", text, status });

describe("提问导航", () => {
  it("摘要去掉代码块和 markdown 记号并截断", () => {
    expect(plainSnippet("## 标题\n```js\nconst a=1\n```\n**加粗** 和 `code` 和 [链接](http://x)")).toBe("标题 加粗 和 code 和 链接");
    expect(plainSnippet("字".repeat(200), 10)).toBe("字".repeat(10) + "…");
  });

  it("每个用户提问一个条目，带紧跟的回答摘要", () => {
    const items = railItems([u("1", "第一问"), a("2", "答一"), u("3", "第二问"), a("4", "", "running"), u("5", "第三问")]);
    expect(items.map(i => i.ask)).toEqual(["第一问", "第二问", "第三问"]);
    expect(items[0]!.reply).toBe("答一");
    expect(items[1]!.reply).toBe("回答中…");
    expect(items[2]!.reply).toBe("");
  });

  it("当前所在：最后一个顶部已滚过视口顶部的提问", () => {
    expect(activeIndex([100, 600, 1200], 0)).toBe(0);
    expect(activeIndex([-900, -300, 400], 0)).toBe(1);
    expect(activeIndex([-900, -300, 60], 0)).toBe(2); // 贴近顶部（80px 内）也算
    expect(activeIndex([], 0)).toBe(0);
  });
});
