export const DUP_TEXT = "这张图片已经在里面了，同一张图片只保留一个";

/** 新来的图片里，有几张是重复的（已经在输入框里，或者这一批里自己重复）。粘贴的图片按内容存文件，所以内容一样路径就一样 */
export function splitDuplicates(existing: string[], incoming: string[]): { fresh: string[]; dup: number } {
  const seen = new Set(existing);
  const fresh: string[] = [];
  let dup = 0;
  for (const p of incoming.filter(Boolean)) {
    if (seen.has(p)) dup++;
    else {
      seen.add(p);
      fresh.push(p);
    }
  }
  return { fresh, dup };
}
