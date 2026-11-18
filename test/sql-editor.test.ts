import { describe, expect, it } from "vitest";
import { formatSql, statementMarks, toggleComment } from "../desktop/renderer/src/lib/sqlText";

describe("statementMarks：每条完整语句的运行按钮位置", () => {
  it("一条没写分号的语句也有按钮，在它所在的行", () => {
    expect(statementMarks("select * from t")).toMatchObject([{ line: 0, text: "select * from t" }]);
  });

  it("多条语句：按钮在各自第一行；跨行的语句只在第一行有", () => {
    const sql = "select 1;\n\nselect a,\n  b\nfrom t;\nupdate t set a = 1";
    const m = statementMarks(sql);
    expect(m.map(x => x.line)).toEqual([0, 2, 5]);
    expect(m[1].text).toBe("select a,\n  b\nfrom t;");
  });

  it("语句前面的空行和注释不算：按钮落在真正有内容的那一行", () => {
    const sql = "-- 查订单\n/* 备注 */\nselect 1;";
    expect(statementMarks(sql).map(x => x.line)).toEqual([2]);
  });

  it("引号和注释里的分号不会把语句切开；纯注释 / 空白没有按钮", () => {
    expect(statementMarks("select 'a;b' as x -- c;d\nfrom t").map(x => x.line)).toEqual([0]);
    expect(statementMarks("-- 只有注释\n\n  ")).toEqual([]);
    expect(statementMarks("")).toEqual([]);
  });

  it("同一行两条语句：只有第一条有按钮", () => {
    expect(statementMarks("select 1; select 2;").map(x => x.text)).toEqual(["select 1;"]);
  });

  it("语句文本里的位置能切回原文", () => {
    const sql = "select 1;\nselect 2;";
    const m = statementMarks(sql);
    expect(sql.slice(m[1].start, m[1].end).trim()).toBe("select 2;");
  });
});

describe("toggleComment", () => {
  it("没选中：注释光标所在行，再来一次取消", () => {
    const sql = "select 1;\nselect 2;";
    const a = toggleComment(sql, 12, 12);
    expect(a.value).toBe("select 1;\n-- select 2;");
    const b = toggleComment(a.value, a.a, a.b);
    expect(b.value).toBe(sql);
  });

  it("选中多行：整段注释；选区结尾落在行首换行后不把下一行算进来", () => {
    const sql = "a\n  b\nc";
    expect(toggleComment(sql, 0, 6).value).toBe("-- a\n  -- b\nc");
    expect(toggleComment("-- a\n  -- b\nc", 0, 12).value).toBe("a\n  b\nc");
  });

  it("空行不动；已有一部分是注释时统一再加一层", () => {
    expect(toggleComment("a\n\nb", 0, 4).value).toBe("-- a\n\n-- b");
    expect(toggleComment("-- a\nb", 0, 6).value).toBe("-- -- a\n-- b");
  });
});

describe("formatSql", () => {
  it("关键字大写，主要子句换行，字段一行一个，AND 缩进", () => {
    expect(formatSql("select a,b from t where x=1 and y>2 order by a desc limit 10;")).toBe(
      ["SELECT", "  a,", "  b", "FROM t", "WHERE x=1", "  AND y>2", "ORDER BY a DESC", "LIMIT 10;"].join("\n"),
    );
  });

  it("JOIN 另起一行，函数括号不加空格，括号里（子查询）不拆行", () => {
    expect(formatSql("select count(*) from a left join b on a.id=b.aid where a.id in (select id from c)")).toBe(
      ["SELECT", "  count(*)", "FROM a", "LEFT JOIN b ON a.id=b.aid", "WHERE a.id IN (SELECT id FROM c)"].join("\n"),
    );
  });

  it("字符串、注释原样保留；多条语句之间空一行", () => {
    const out = formatSql("select 'from where' as s; select 2");
    expect(out).toBe(["SELECT", "  'from where' AS s;", "", "SELECT", "  2"].join("\n"));
    expect(formatSql("select 1 -- 备注\nfrom t")).toBe(["SELECT", "  1 -- 备注", "FROM t"].join("\n"));
  });

  it("点后面的词是字段名，不当关键字改大写", () => {
    expect(formatSql("select t.key from t")).toContain("t.key");
  });

  it("UPDATE ... SET 一个字段一行；格式化两次结果不变", () => {
    const once = formatSql("update t set a=1,b=2 where id=3");
    expect(once).toBe(["UPDATE t", "SET", "  a=1,", "  b=2", "WHERE id=3"].join("\n"));
    expect(formatSql(once)).toBe(once);
  });
});
