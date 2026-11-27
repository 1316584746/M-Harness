/** 把 git diff 的正文（从 @@ 开始）切成一行一行，给改动预览画行号、增删底色用 */
export interface DiffLine {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  /** 旧文件行号（删除行 / 上下文行有） */
  old?: number;
  /** 新文件行号（新增行 / 上下文行有） */
  new?: number;
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  for (const line of patch.replace(/\r?\n$/, "").split(/\r?\n/)) {
    const h = HUNK.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      // 第一个块从第 1 行开始时不画块头（新文件整篇都是新增，块头只是噪音）
      if (!(out.length === 0 && o <= 1 && n <= 1)) out.push({ kind: "hunk", text: line.replace(HUNK, "").trim() || `第 ${n} 行起` });
      continue;
    }
    if (line.startsWith("\\")) continue; // 「\ No newline at end of file」
    if (line.startsWith("+")) out.push({ kind: "add", new: n++, text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ kind: "del", old: o++, text: line.slice(1) });
    else if (line.startsWith(" ")) out.push({ kind: "ctx", old: o++, new: n++, text: line.slice(1) });
    else if (line.startsWith("…")) out.push({ kind: "note", text: line });
  }
  return out;
}

/** 文件名取扩展名当高亮语言（没有就空串，按纯文本） */
export function langOf(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : base.toLowerCase();
}

export function sumChanges(files: Array<{ added: number; removed: number }>): { added: number; removed: number } {
  return files.reduce((s, f) => ({ added: s.added + f.added, removed: s.removed + f.removed }), { added: 0, removed: 0 });
}
