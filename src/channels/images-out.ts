import fs from "node:fs";

/** 飞书图片消息的大小上限 */
const MAX_BYTES = 10 * 1024 * 1024;
/** 一条回复最多补发几张 */
export const MAX_OUT_IMAGES = 4;

// 前面不能紧挨着字母数字 / : / \ / .：免得把网址（https://host/a.png）拆出「//host/a.png」当成 Windows 网络路径去访问
const RE = /(?<![A-Za-z0-9_:/\\.])(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|*?()（）\[\]，。；、]+?\.(?:png|jpe?g|gif|webp)\b/gi;

/**
 * 从回复文字里找「本次运行里刚生成的图片」：写着本机绝对路径、文件存在、修改时间不早于这次运行开始。
 * 只认运行期间新写的文件，Agent 随口提到的旧文件（可能是别的敏感图片）不会被发出去。
 */
export function findReplyImages(text: string, since: number, max = MAX_OUT_IMAGES): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(RE)) {
    const p = m[0];
    if (out.includes(p) || p.startsWith("//") || p.startsWith("\\\\")) continue; // 网络路径（UNC）不碰：statSync 会去连对方机器
    
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0 && st.size <= MAX_BYTES && st.mtimeMs >= since - 5000) out.push(p);
    } catch {
      /* 不存在就跳过 */
    }
    if (out.length >= max) break;
  }
  return out;
}
