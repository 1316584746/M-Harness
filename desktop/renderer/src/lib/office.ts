/**
 * 办公集成「同一时间只启用一个平台」：飞书 / 钉钉 / 自定义。
 *
 * - 配置里 office.active 记录当前启用的平台；老配置没有这个字段时，按已有的飞书 / 钉钉设置推断。
 * - 切走某个平台时，它的配置（飞书的消息通道和项目、钉钉的项目管理）不丢：先收进 office.stash，
 *   以后再打开这个平台时原样恢复（允许的用户、默认空间、是否允许写入都还在）。
 * - 平台「启用」的含义和原来一致：对应的配置存在，通道 / 项目管理工具才会生效。
 */

export type OfficePlatform = "feishu" | "dingtalk" | "custom";
export const PLATFORMS: OfficePlatform[] = ["feishu", "dingtalk", "custom"];

type Cfg = Record<string, any>;

/** 每个平台在配置里占用的位置（点号路径） */
const PIECES: Record<Exclude<OfficePlatform, "custom">, Array<{ path: [string, string]; make: () => unknown }>> = {
  feishu: [
    { path: ["channels", "larkCli"], make: () => ({ bin: "lark-cli", allowUsers: [] }) },
    { path: ["integrations", "feishuProject"], make: () => ({ bin: "meegle", write: true }) },
  ],
  dingtalk: [{ path: ["integrations", "dingtalkProject"], make: () => ({ write: false }) }],
};

const isPlatform = (v: unknown): v is OfficePlatform => v === "feishu" || v === "dingtalk" || v === "custom";

/** 当前启用的平台；都没启用返回 null */
export function activePlatform(cfg: Cfg | null | undefined): OfficePlatform | null {
  if (!cfg) return null;
  const a = cfg.office?.active;
  if (isPlatform(a)) return a;
  if (cfg.channels?.larkCli || cfg.integrations?.feishuProject) return "feishu";
  if (cfg.integrations?.dingtalkProject) return "dingtalk";
  return null;
}

/** 启用 target（并关掉其它平台）；target 为 null 表示全部关闭。就地修改 cfg */
export function setPlatform(cfg: Cfg, target: OfficePlatform | null): void {
  cfg.office ??= {};
  const stash: Cfg = (cfg.office.stash ??= {});
  for (const p of ["feishu", "dingtalk"] as const) {
    for (const piece of PIECES[p]) {
      const [a, b] = piece.path;
      const live = cfg[a]?.[b];
      if (p !== target) {
        // 切走：配置收起来，不删
        if (live) {
          (stash[p] ??= {})[`${a}.${b}`] = live;
          delete cfg[a][b];
        }
      } else if (!live) {
        // 切到：优先恢复以前收起来的，没有就用默认值
        cfg[a] ??= {};
        cfg[a][b] = stash[p]?.[`${a}.${b}`] ?? piece.make();
        if (stash[p]) delete stash[p][`${a}.${b}`];
      }
    }
    if (stash[p] && !Object.keys(stash[p]).length) delete stash[p];
  }
  if (!Object.keys(stash).length) delete cfg.office.stash;
  if (target) cfg.office.active = target;
  else delete cfg.office.active;
  if (!Object.keys(cfg.office).length) delete cfg.office;
}
