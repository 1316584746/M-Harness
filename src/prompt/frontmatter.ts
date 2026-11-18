import YAML from "yaml";

/** 解析文件开头的 --- yaml --- 头；没有则返回空 meta 和原文 */
export function parseFrontmatter(text: string): { meta: Record<string, any>; body: string; hasMeta: boolean } {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { meta: {}, body: src, hasMeta: false };
  let meta: Record<string, any> = {};
  try {
    const v = YAML.parse(m[1]);
    if (v && typeof v === "object") meta = v as Record<string, any>;
  } catch {
    /* 头部写坏了就当没有 */
  }
  return { meta, body: src.slice(m[0].length), hasMeta: true };
}
