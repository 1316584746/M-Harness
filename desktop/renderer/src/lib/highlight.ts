/**
 * 代码块的语法高亮：不引第三方库，按「语言家族」做一遍简单的词法切分。
 * 目标是让 Java / TS / SQL / JSON / Shell 等读起来像代码，而不是追求编译器级的精确。
 * 返回的是词元数组（界面用 <span> 渲染，不拼 HTML，所以不会有注入问题）。
 */
export interface Tok {
  /** 词元类别：k 关键字 s 字符串 c 注释 n 数字 t 类型 f 函数 a 注解 p 属性名 d 增 / x 删 / h 块头；没有就是普通文本 */
  c?: "k" | "s" | "c" | "n" | "t" | "f" | "a" | "p" | "d" | "x" | "h";
  s: string;
}

type Family = "clike" | "hash" | "sql" | "json" | "xml" | "diff" | "plain";

const KW_CLIKE = new Set(
  (
    "abstract as assert async await boolean break byte case catch char class const continue debugger default defer delete do double else enum export extends " +
    "extern false final finally float fn for from func function go goto if impl implements import in instanceof int interface let long match mod module mut namespace " +
    "native new nil null of override package private protected pub public readonly return select self short static struct super switch synchronized this throw throws " +
    "trait true try type typeof union unsafe use val var virtual void volatile where while with yield record sealed permits var object when fun data lateinit"
  ).split(" "),
);
const KW_HASH = new Set(
  (
    "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield " +
    "fi then do done esac case function local export echo exit set unset source alias readonly shift trap true false null"
  ).split(" "),
);
const KW_SQL = new Set(
  (
    "select from where and or not in is null like between exists distinct group by order having limit offset join left right inner outer full cross on as union all insert into values update set delete " +
    "create alter drop table index view database schema primary key foreign references default unique check constraint add column case when then else end asc desc with recursive over partition " +
    "count sum avg min max coalesce ifnull cast true false begin commit rollback explain truncate if using returning"
  ).split(" "),
);

/** 语言名（或文件扩展名）→ 家族 */
const FAMILY: Record<string, Family> = {
  java: "clike", kotlin: "clike", kt: "clike", scala: "clike", groovy: "clike", js: "clike", jsx: "clike", ts: "clike", tsx: "clike", javascript: "clike", typescript: "clike", mjs: "clike", cjs: "clike",
  go: "clike", rust: "clike", rs: "clike", c: "clike", h: "clike", cpp: "clike", cc: "clike", hpp: "clike", cs: "clike", csharp: "clike", swift: "clike", php: "clike", dart: "clike", vue: "clike",
  css: "clike", scss: "clike", less: "clike", proto: "clike", gradle: "clike",
  python: "hash", py: "hash", sh: "hash", bash: "hash", shell: "hash", zsh: "hash", yaml: "hash", yml: "hash", toml: "hash", properties: "hash", ini: "hash", conf: "hash", env: "hash",
  dockerfile: "hash", makefile: "hash", ruby: "hash", rb: "hash", perl: "hash", r: "hash", powershell: "hash", ps1: "hash",
  sql: "sql", mysql: "sql", pgsql: "sql", postgresql: "sql", postgres: "sql", plpgsql: "sql",
  json: "json", jsonc: "json", json5: "json",
  xml: "xml", html: "xml", htm: "xml", svg: "xml", pom: "xml", xhtml: "xml",
  diff: "diff", patch: "diff",
};

/** 从代码块的信息串里取出 { 语言, 引用的文件路径, 行号范围 }；认「起始行:结束行:路径」这种代码引用，也认 ```java 这种 */
export function parseFence(info: string): { lang: string; path?: string; range?: string } {
  const raw = info.trim();
  const ref = /^(\d+):(\d+):(.+)$/.exec(raw);
  if (ref) {
    const p = ref[3].trim();
    const ext = /\.([A-Za-z0-9]+)$/.exec(p)?.[1]?.toLowerCase() ?? "";
    const base = p.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    return { lang: base === "dockerfile" || base === "makefile" ? base : ext, path: p, range: `${ref[1]}-${ref[2]}` };
  }
  return { lang: raw.split(/[\s{]/)[0].toLowerCase() };
}

function familyOf(lang: string): Family {
  return FAMILY[lang.toLowerCase()] ?? "plain";
}

const MAX_LEN = 200_000;

type Rule = [RegExp, Tok["c"] | "kw" | "word"];

const NUM = /(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[lLfFdD]?)\b/y;
const WORD = /[A-Za-z_$][\w$]*/y;

function rulesOf(f: Family): Rule[] {
  switch (f) {
    case "clike":
      return [
        [/\/\*[\s\S]*?(?:\*\/|$)/y, "c"],
        [/\/\/[^\n]*/y, "c"],
        [/"""[\s\S]*?(?:"""|$)/y, "s"],
        [/"(?:\\.|[^"\\\n])*"?/y, "s"],
        [/'(?:\\.|[^'\\\n])*'?/y, "s"],
        [/`(?:\\[\s\S]|[^`\\])*`?/y, "s"],
        [/@[A-Za-z_][\w.]*/y, "a"],
        [NUM, "n"],
        [WORD, "word"],
      ];
    case "hash":
      return [
        [/#[^\n]*/y, "c"],
        [/"""[\s\S]*?(?:"""|$)/y, "s"],
        [/'''[\s\S]*?(?:'''|$)/y, "s"],
        [/"(?:\\.|[^"\\\n])*"?/y, "s"],
        [/'(?:\\.|[^'\\\n])*'?/y, "s"],
        [/@[A-Za-z_][\w.]*/y, "a"],
        [NUM, "n"],
        [WORD, "word"],
      ];
    case "sql":
      return [
        [/--[^\n]*/y, "c"],
        [/#[^\n]*/y, "c"],
        [/\/\*[\s\S]*?(?:\*\/|$)/y, "c"],
        [/'(?:''|\\.|[^'\\])*'?/y, "s"],
        [/"(?:""|[^"])*"?/y, "s"],
        [/`[^`]*`?/y, "p"],
        [NUM, "n"],
        [WORD, "word"],
      ];
    case "json":
      return [
        [/\/\/[^\n]*/y, "c"],
        [/\/\*[\s\S]*?(?:\*\/|$)/y, "c"],
        [/"(?:\\.|[^"\\\n])*"(?=\s*:)/y, "p"],
        [/"(?:\\.|[^"\\\n])*"?/y, "s"],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, "n"],
        [/\b(?:true|false|null)\b/y, "k"],
      ];
    case "xml":
      return [
        [/<!--[\s\S]*?(?:-->|$)/y, "c"],
        [/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/y, "s"],
        [/<\/?[A-Za-z_][\w:.-]*/y, "k"],
        [/\/?>/y, "k"],
        [/"[^"]*"?/y, "s"],
        [/'[^']*'?/y, "s"],
        [/[A-Za-z_:][\w:.-]*(?=\s*=)/y, "p"],
      ];
    default:
      return [];
  }
}

function highlightDiff(code: string): Tok[] {
  const out: Tok[] = [];
  const lines = code.split("\n");
  lines.forEach((ln, i) => {
    const nl = i < lines.length - 1 ? "\n" : "";
    const c: Tok["c"] = /^(\+\+\+|---|diff |index )/.test(ln) ? "h" : ln.startsWith("@@") ? "h" : ln.startsWith("+") ? "d" : ln.startsWith("-") ? "x" : undefined;
    out.push({ c, s: ln + nl });
  });
  return out;
}

/** 把一段代码切成词元；认不出的语言原样一个词元返回 */
export function highlight(code: string, lang: string): Tok[] {
  const f = familyOf(lang);
  if (f === "plain" || code.length > MAX_LEN) return [{ s: code }];
  if (f === "diff") return highlightDiff(code);
  const rules = rulesOf(f);
  const kws = f === "clike" ? KW_CLIKE : f === "hash" ? KW_HASH : f === "sql" ? KW_SQL : undefined;
  const out: Tok[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ s: plain });
    plain = "";
  };
  let i = 0;
  while (i < code.length) {
    let hit: { len: number; c?: Tok["c"] } | undefined;
    for (const [re, kind] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (!m || m[0] === "") continue;
      if (kind === "word") {
        const w = m[0];
        const key = f === "sql" ? w.toLowerCase() : w;
        if (kws?.has(key)) hit = { len: w.length, c: "k" };
        else if (/^[A-Z][A-Za-z0-9_$]*$/.test(w) && w.length > 1 && f !== "sql") hit = { len: w.length, c: /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(w) ? "n" : "t" };
        else if (/^\s*\(/.test(code.slice(i + w.length, i + w.length + 3))) hit = { len: w.length, c: "f" };
        else hit = { len: w.length };
      } else hit = { len: m[0].length, c: kind as Tok["c"] };
      break;
    }
    if (!hit) {
      plain += code[i];
      i += 1;
      continue;
    }
    const text = code.slice(i, i + hit.len);
    if (hit.c) {
      flush();
      out.push({ c: hit.c, s: text });
    } else plain += text;
    i += hit.len;
  }
  flush();
  return out;
}
