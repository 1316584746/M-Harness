/** apiKey 字段形如 ${VAR} 时取 VAR；否则按提供方名生成变量名 */
export function envVarFor(name: string, apiKey: unknown): string {
  const m = typeof apiKey === "string" ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(apiKey) : null;
  if (m) return m[1];
  const ascii = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (/^[\x00-\x7f]*$/.test(name)) return `${ascii}_API_KEY`;
  // 名字里有中文等：环境变量只能是英文数字，补一段由名字算出的短码，保证不同名字不会撞到同一个变量
  let h = 5381;
  for (const ch of name) h = (Math.imul(h, 33) + ch.codePointAt(0)!) >>> 0;
  return `${ascii.replace(/^_+|_+$/g, "") || "PROVIDER"}_${h.toString(36).toUpperCase()}_API_KEY`;
}
