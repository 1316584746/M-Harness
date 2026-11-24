/**
 * 插件后台调用失败时，哪些不用顶部弹红条。
 *
 * 红条的意思是「插件后台坏了」。但插件常常会为了兼容不同版本的服务端，主动去试一些可能不存在的接口，
 * 失败了自己吞掉（界面上不受影响）。典型例子：GitLab 控制台在 15.4 的服务端上请求 15.7 才有的 /diffs，
 * 返回「not_found: 404 Not Found」。这类「资源 / 接口不存在」不是插件坏了：
 * 错误照样原样回给插件（它该提示就会在自己界面里提示），只是宿主不再跳红条吓人。
 */
export function isBenignPluginError(msg: string): boolean {
  const s = (msg ?? "").trim();
  if (!s) return false;
  return /^not_found\b/i.test(s) || /^(http\s*)?404\b/i.test(s);
}
