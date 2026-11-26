import { describe, expect, it } from "vitest";
import { highlight, parseFence } from "../desktop/renderer/src/lib/highlight";

const kinds = (code: string, lang: string) => highlight(code, lang).filter(t => t.c).map(t => `${t.c}:${t.s}`);

describe("代码块语法高亮", () => {
  it("代码引用「起始行:结束行:路径」：取出路径、行号范围，语言按扩展名认", () => {
    expect(parseFence("74:85:src/main/java/com/x/StudentProfileService.java")).toEqual({ lang: "java", path: "src/main/java/com/x/StudentProfileService.java", range: "74-85" });
    expect(parseFence("java")).toEqual({ lang: "java" });
    expect(parseFence("")).toEqual({ lang: "" });
  });

  it("Java：关键字、类型、注解、字符串、注释、数字、方法调用", () => {
    const k = kinds('@Override public String get(UUID id) { // 取\n  return "a" + 42; }', "java");
    expect(k).toContain("a:@Override");
    expect(k).toContain("k:public");
    expect(k).toContain("t:String");
    expect(k).toContain("t:UUID");
    expect(k).toContain("f:get");
    expect(k).toContain("c:// 取");
    expect(k).toContain('s:"a"');
    expect(k).toContain("n:42");
    expect(k).toContain("k:return");
  });

  it("切分后拼回去和原文完全一致（任何语言）", () => {
    const src = 'if (!this.isTeachingStaffAndAbove(wkUser)) {\n  log.info("当前账户:{}未查询到", userId); /* x */\n}\n`tpl ${a}`';
    for (const l of ["java", "ts", "python", "sql", "json", "xml", "diff", "unknown"]) expect(highlight(src, l).map(t => t.s).join("")).toBe(src);
  });

  it("SQL 关键字不分大小写；JSON 区分键和值；diff 按行着色", () => {
    expect(kinds("SELECT id FROM t WHERE a = 'x' -- 注", "sql")).toEqual(["k:SELECT", "k:FROM", "k:WHERE", "s:'x'", "c:-- 注"]);
    expect(kinds('{"a": "b", "n": 1, "ok": true}', "json")).toEqual(['p:"a"', 's:"b"', 'p:"n"', "n:1", 'p:"ok"', "k:true"]);
    expect(highlight("+new\n-old\n@@ -1 +1 @@\nsame", "diff").map(t => t.c)).toEqual(["d", "x", "h", undefined]);
  });

  it("不认识的语言和超长文本不处理", () => {
    expect(highlight("whatever", "klingon")).toEqual([{ s: "whatever" }]);
    expect(highlight("a".repeat(200_001), "java")).toHaveLength(1);
  });
});
