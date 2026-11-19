/**
 * 把网络层的英文报错换成人话：Node 的 fetch 超时是 "The operation was aborted due to timeout"，
 * 连不上是 "fetch failed"（原因在 cause 里），用户看不懂也不知道怎么办。
 * 已经是中文的信息原样返回。
 */
export function netError(e: unknown): string {
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } } | undefined;
  const msg = err?.message ?? String(e);
  if (/[\u4e00-\u9fa5]/.test(msg)) return msg;
  const code = err?.cause?.code ?? err?.code ?? "";
  if (err?.name === "TimeoutError" || err?.name === "AbortError" || /aborted due to timeout|timed? ?out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(msg + code)) return "网络超时：对方服务器太慢或连不上（GitHub、npm 在国内常见）。换个网络或稍后再试";
  if (/ENOTFOUND|EAI_AGAIN/.test(code + msg)) return "域名解析失败：连不上网，或者这个网站被屏蔽了";
  if (/ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR_SOCKET|socket hang up|fetch failed/i.test(code + msg)) return `网络连接被中断或拒绝${code ? `（${code}）` : ""}：检查网络或代理后重试`;
  return msg;
}
