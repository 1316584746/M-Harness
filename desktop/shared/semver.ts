/**
 * 够用的 semver：解析、比较、判断版本是否满足 npm 的范围写法（^ ~ >= x-range、|| 、连字符区间）。
 * 只给安装 npm 插件时挑版本用，不求覆盖所有冷门写法；认不出来的范围一律当作「不满足」。
 */

export interface Ver {
  major: number;
  minor: number;
  patch: number;
  pre: Array<string | number>;
}

const VER_RE = /^v?=?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVer(s: string): Ver | null {
  const m = VER_RE.exec(s.trim());
  if (!m) return null;
  return { major: +m[1], minor: +(m[2] ?? 0), patch: +(m[3] ?? 0), pre: m[4] ? m[4].split(".").map(x => (/^\d+$/.test(x) ? +x : x)) : [] };
}

export function cmpVer(a: Ver, b: Ver): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1; // 有预发布标记的比正式版小
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 字符串版本的比较（解析不了的排在最前） */
export function cmpVerStr(a: string, b: string): number {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  return cmpVer(x, y);
}

type Op = ">=" | ">" | "<=" | "<" | "=";
interface Cmp {
  op: Op;
  v: Ver;
}

const ver = (major: number, minor = 0, patch = 0, pre: Array<string | number> = []): Ver => ({ major, minor, patch, pre });

/** 一个带通配的版本（1、1.2、1.x、1.2.3-beta.1）拆成各段；段缺省或 x / * 记为 undefined */
function partial(s: string): { major?: number; minor?: number; patch?: number; pre: Array<string | number> } | null {
  const m = /^v?=?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s.trim());
  if (!m) return null;
  const n = (x?: string) => (x === undefined || /^[xX*]$/.test(x) ? undefined : +x);
  return { major: n(m[1]), minor: n(m[2]), patch: n(m[3]), pre: m[4] ? m[4].split(".").map(x => (/^\d+$/.test(x) ? +x : x)) : [] };
}

function expandToken(tok: string): Cmp[] | null {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/.exec(tok);
  if (!m) return null;
  const op = m[1] ?? "";
  const p = partial(m[2]);
  if (!p) return null;
  if (p.major === undefined) return op.startsWith("<") || op === ">" ? [{ op: "<", v: ver(0, 0, 0, [0]) }] : []; // * 任意版本
  const { major, minor, patch, pre } = p;
  const lo = ver(major, minor ?? 0, patch ?? 0, pre);
  if (op === "^") {
    const hi = major > 0 || minor === undefined ? ver(major + 1) : minor > 0 || patch === undefined ? ver(0, minor + 1) : ver(0, 0, patch + 1);
    return [{ op: ">=", v: lo }, { op: "<", v: hi }];
  }
  if (op.startsWith("~")) return [{ op: ">=", v: lo }, { op: "<", v: minor === undefined ? ver(major + 1) : ver(major, minor + 1) }];
  if (op === ">=") return [{ op: ">=", v: lo }];
  if (op === "<") return [{ op: "<", v: lo }];
  if (op === ">") return minor === undefined ? [{ op: ">=", v: ver(major + 1) }] : patch === undefined ? [{ op: ">=", v: ver(major, minor + 1) }] : [{ op: ">", v: lo }];
  if (op === "<=") return minor === undefined ? [{ op: "<", v: ver(major + 1) }] : patch === undefined ? [{ op: "<", v: ver(major, minor + 1) }] : [{ op: "<=", v: lo }];
  // 精确，或 1.x 这样的通配
  if (minor === undefined) return [{ op: ">=", v: ver(major) }, { op: "<", v: ver(major + 1) }];
  if (patch === undefined) return [{ op: ">=", v: ver(major, minor) }, { op: "<", v: ver(major, minor + 1) }];
  return [{ op: "=", v: lo }];
}

function parseRange(range: string): Cmp[][] | null {
  const groups: Cmp[][] = [];
  for (const g of range.split("||")) {
    let s = g.trim().replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1"); // "^ 1.2" → "^1.2"
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hy) s = `>=${hy[1]} <=${hy[2]}`;
    const cmps: Cmp[] = [];
    for (const tok of s.split(/\s+/).filter(Boolean)) {
      const e = expandToken(tok);
      if (!e) return null;
      cmps.push(...e);
    }
    groups.push(cmps);
  }
  return groups;
}

const test = (v: Ver, c: Cmp): boolean => {
  const d = cmpVer(v, c.v);
  return c.op === ">=" ? d >= 0 : c.op === ">" ? d > 0 : c.op === "<=" ? d <= 0 : c.op === "<" ? d < 0 : d === 0;
};

export function satisfies(version: string, range: string): boolean {
  const v = parseVer(version);
  const groups = parseRange(range.trim() === "" || range.trim() === "latest" ? "*" : range);
  if (!v || !groups) return false;
  return groups.some(cmps => {
    if (!cmps.every(c => test(v, c))) return false;
    // 预发布版本只在范围里明确写了同一个 主.次.修订 的预发布时才算满足
    return !v.pre.length || cmps.some(c => c.v.pre.length && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch);
  });
}

/** 从版本列表里挑满足范围的最高版本；范围是 dist-tag 名（latest / next）时用 tags 里的 */
export function pickVersion(versions: string[], range: string, tags: Record<string, string> = {}): string | undefined {
  const r = range.trim();
  if (r in tags && !/^[\d^~<>=*xX|]/.test(r)) return versions.includes(tags[r]) ? tags[r] : undefined;
  const ok = versions.filter(v => satisfies(v, r));
  if (!ok.length) return r === "" || r === "*" || r === "latest" ? tags.latest : undefined;
  return ok.sort(cmpVerStr).pop();
}
