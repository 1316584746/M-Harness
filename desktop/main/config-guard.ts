/** 保存配置前的保险：登记的仓库被一次保存抹掉时，把旧文件留一份，免得「仓库不见了」没处找 */

function repoNames(text: string): string[] {
  try {
    const j = JSON.parse(text.replace(/^\uFEFF/, ""));
    return j && typeof j.repos === "object" && j.repos ? Object.keys(j.repos) : [];
  } catch {
    return [];
  }
}

/** 旧配置里有、新配置里没有的仓库名 */
export function lostRepos(prevText: string, nextText: string): string[] {
  const next = new Set(repoNames(nextText));
  return repoNames(prevText).filter(n => !next.has(n));
}

/** 备份文件名（落在 harness.config.*.json 的忽略规则里，不会被提交） */
export const REPOS_BACKUP = "harness.config.repos-backup.json";
