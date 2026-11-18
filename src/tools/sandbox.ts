import fs from "node:fs";
import path from "node:path";

/**
 * 把用户/模型给的路径解析到沙箱根目录之内。
 * - 相对路径相对于 root；
 * - 用 realpath 解析已存在的最近祖先，防止符号链接/junction 逃逸；
 * - Windows 下大小写不敏感比较。
 */
export function resolveInside(root: string, p: string): string {
  const rootReal = realpathSafe(path.resolve(root));
  const abs = path.resolve(rootReal, p);

  // 找到最近的已存在祖先并取 realpath，再拼回不存在的部分
  let existing = abs;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  const real = path.join(realpathSafe(existing), ...rest);

  if (!isInside(rootReal, real)) {
    throw new Error(`路径越界：${p} 不在沙箱目录 ${rootReal} 之内`);
  }
  return real;
}

export function isInside(root: string, target: string): boolean {
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}
