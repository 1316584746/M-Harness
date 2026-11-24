import { runMeegle, type FeishuProjectConfig } from "./feishu-project";
import { spawnCli } from "./cli-spawn";
import { parseJson } from "./workbench";

/** 一个需求（飞书项目工作项）对应的飞书群 */
export interface WorkChat {
  ok: boolean;
  /** 需求没有拉群（拉群方式是「不拉群」或还没建） */
  none?: boolean;
  /** 群 id（oc_ 开头） */
  groupId?: string;
  /** 群名（要登录了 lark-cli 才读得到，读不到就没有） */
  name?: string;
  /** 群状态：normal / dissolved / ... */
  status?: string;
  /** 拉群方式（飞书项目里的「拉群方式选择」），如「自动拉群」 */
  how?: string;
  /** 在飞书客户端里打开这个群的链接 */
  link?: string;
  /** 需求本身没关联群时，按需求名在「我所在的群」里搜到的可能的群（供一键绑定） */
  candidates?: Array<{ id: string; name: string }>;
  error?: string;
}

const SAFE_ID = /^[\w.-]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 从 workitem get 的结果里读「拉群方式选择」字段：{ group_id, label } */
export function parseGroupField(json: unknown): { groupId?: string; how?: string; found: boolean } {
  const fields = isObj(json) ? (json.work_item_fields ?? (isObj(json.data) ? json.data.work_item_fields : undefined)) : undefined;
  if (!Array.isArray(fields)) return { found: false };
  const f = fields.find(x => isObj(x) && (x.key === "group_type" || x.field_key === "group_type"));
  if (!isObj(f)) return { found: false };
  const v = isObj(f.value) ? f.value : {};
  const id = typeof v.group_id === "string" ? v.group_id.trim() : "";
  return { found: true, groupId: /^oc_[\w]+$/.test(id) ? id : undefined, how: typeof v.label === "string" ? v.label : undefined };
}

/** 项目空间：优先用 project_key，没有就从需求链接里取空间简称（https://project.feishu.cn/<space>/story/detail/<id>） */
export function spaceOf(projectKey: string | undefined, url: string | undefined): string | undefined {
  if (projectKey && SAFE_ID.test(projectKey)) return projectKey;
  const m = /^https?:\/\/[^/]*(?:feishu|larkoffice|larksuite)[^/]*\/([\w.-]+)\/[\w-]+\/detail\/\d+/i.exec(url ?? "");
  return m && m[1] !== "goapi" ? m[1] : undefined;
}

export interface LarkBin {
  bin: string;
  binArgs?: string[];
}

function larkApi(cfg: LarkBin, apiPath: string, as: "user" | "bot"): Promise<unknown | null> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnCli(cfg.bin, [...(cfg.binArgs ?? []), "api", "GET", apiPath, "--as", as]);
    } catch {
      return resolve(null);
    }
    const out: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("error", () => (clearTimeout(timer), resolve(null)));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseJson(Buffer.concat(out).toString("utf8")));
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}

/** 群名和状态：先用用户身份（能看到自己所在的群），不行再用机器人身份 */
export async function chatInfo(cfg: LarkBin, groupId: string): Promise<{ name?: string; status?: string }> {
  for (const as of ["user", "bot"] as const) {
    const j = await larkApi(cfg, `/open-apis/im/v1/chats/${groupId}`, as);
    const d = isObj(j) && j.ok !== false && isObj(j.data) ? j.data : undefined;
    if (!d) continue;
    const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : undefined;
    const status = typeof d.chat_status === "string" ? d.chat_status : undefined;
    if (name || status) return { name, status };
  }
  return {};
}

/** 从用户填的内容里认出群 ID：直接填 oc_xxx，或贴群链接（带 openChatId=oc_xxx） */
export function parseChatRef(input: string): string | undefined {
  const m = /\boc_[A-Za-z0-9]+/.exec(String(input ?? ""));
  return m?.[0];
}

const chatLink = (id: string) => `https://applink.feishu.cn/client/chat/open?openChatId=${id}`;

/** 查一个指定的群（手动关联的群）：读得到名字就带上，读不到也不报错（lark-cli 没登录时就是这样） */
export async function inspectChat(lark: LarkBin | undefined, groupId: string): Promise<WorkChat> {
  if (!/^oc_[A-Za-z0-9]+$/.test(groupId)) return { ok: false, error: "群 ID 格式不对，应该是 oc_ 开头的一串字母数字" };
  const info = await chatInfo(lark ?? { bin: "lark-cli" }, groupId).catch(() => ({}) as { name?: string; status?: string });
  return { ok: true, groupId, how: "手动关联", name: info.name, status: info.status, link: chatLink(groupId) };
}

/** lark-cli 失败时 stdout 是 { error: { message, missing_scopes } }：缺权限时给出该怎么授权，其他情况给原因 */
export function explainCliError(stdout: string, stderr: string): string {
  const j = parseJson(stdout);
  const e = isObj(j) && isObj(j.error) ? j.error : undefined;
  if (e) {
    const scopes = Array.isArray(e.missing_scopes) ? e.missing_scopes.filter((x): x is string => typeof x === "string") : [];
    if (scopes.length) return `lark-cli 还没授权「${scopes.join("、")}」权限。在终端运行：lark-cli auth login --scope "${scopes.join(" ")}"，登录完成后再点一次。`;
    if (typeof e.message === "string" && e.message) return e.message.slice(0, 240);
  }
  return (stderr || stdout).replace(/\s+/g, " ").trim().slice(0, 240);
}

/** 用 lark-cli 以当前登录用户的身份建一个群并返回群 ID；失败如实带回原因 */
export function createChat(lark: LarkBin | undefined, req: { name: string; description?: string }): Promise<WorkChat> {
  const name = req.name.replace(/[\r\n]+/g, " ").trim().slice(0, 60);
  if (!name) return Promise.resolve({ ok: false, error: "群名不能为空" });
  const cfg = lark ?? { bin: "lark-cli" };
  const args = [...(cfg.binArgs ?? []), "im", "+chat-create", "--as", "user", "--type", "private", "--name", name, "--format", "json"];
  const desc = (req.description ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 100);
  if (desc) args.push("--description", desc);
  return new Promise(resolve => {
    let child;
    try {
      child = spawnCli(cfg.bin, args);
    } catch (e) {
      return resolve({ ok: false, error: `启动 lark-cli 失败：${e instanceof Error ? e.message : String(e)}` });
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", e => (clearTimeout(timer), resolve({ ok: false, error: `找不到 lark-cli：${e.message}` })));
    child.on("close", async code => {
      clearTimeout(timer);
      const so = Buffer.concat(out).toString("utf8");
      const se = Buffer.concat(err).toString("utf8");
      const id = code === 0 ? parseChatRef(so) : undefined;
      if (!id) return resolve({ ok: false, error: explainCliError(so, se) || `建群失败（lark-cli 退出码 ${code}）` });
      const info = await chatInfo(cfg, id).catch(() => ({}) as { name?: string; status?: string });
      resolve({ ok: true, groupId: id, how: "手动关联", name: info.name ?? name, status: info.status, link: chatLink(id) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}

function larkSearch(cfg: LarkBin, query: string): Promise<unknown | null> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnCli(cfg.bin, [...(cfg.binArgs ?? []), "api", "GET", "/open-apis/im/v1/chats/search", "--params", JSON.stringify({ query, page_size: 20 }), "--as", "user"]);
    } catch {
      return resolve(null);
    }
    const out: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("error", () => (clearTimeout(timer), resolve(null)));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseJson(Buffer.concat(out).toString("utf8")));
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}

/** 去掉标题里的【】括号，剩下的当搜索词：「【数英满班率】组班」→「数英满班率 组班」 */
export function chatQueries(title: string): string[] {
  const t = title.replace(/\s+/g, " ").trim();
  const bracket = [...t.matchAll(/【([^】]+)】/g)].map(m => m[1].trim()).filter(Boolean);
  const rest = t.replace(/【[^】]*】/g, " ").replace(/\s+/g, " ").trim();
  return [...new Set([t, bracket[0], [bracket[0], rest].filter(Boolean).join(" ")].filter((x): x is string => !!x && x.length >= 2))].slice(0, 3);
}

/** 按需求名在「我所在的群」里找可能的群：名字里同时含括号里的关键词和正文的排前面 */
export async function findChatCandidates(lark: LarkBin | undefined, title: string): Promise<Array<{ id: string; name: string }>> {
  const cfg = lark ?? { bin: "lark-cli" };
  const seen = new Map<string, string>();
  for (const q of chatQueries(title)) {
    const j = await larkSearch(cfg, q);
    const items = isObj(j) && j.ok !== false && isObj(j.data) && Array.isArray(j.data.items) ? j.data.items : [];
    for (const it of items) {
      if (!isObj(it)) continue;
      const id = typeof it.chat_id === "string" ? it.chat_id : "";
      const name = typeof it.name === "string" ? it.name.trim() : "";
      if (/^oc_[A-Za-z0-9]+$/.test(id) && name && !seen.has(id)) seen.set(id, name);
    }
  }
  const core = title.replace(/[【】\s]/g, "");
  const score = (n: string) => (n.replace(/[【】\s]/g, "").includes(core) ? 0 : 1);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => score(a.name) - score(b.name)).slice(0, 8);
}

/** 读一个需求对应的飞书群；没拉群就如实说没有，不会编一个 */
export async function fetchWorkItemChat(fp: FeishuProjectConfig, lark: LarkBin | undefined, req: { projectKey?: string; wid: string; url?: string; title?: string }): Promise<WorkChat> {
  if (!req.wid || !SAFE_ID.test(req.wid)) return { ok: false, error: "缺少需求 ID" };
  // 任务上没记空间（老任务、或没从工作台点进来）：先看需求链接，再用设置里配的默认空间
  const dflt = fp.defaultSpace?.key;
  const space = spaceOf(req.projectKey, req.url) ?? (dflt && SAFE_ID.test(dflt) ? dflt : undefined);
  if (!space) return { ok: false, error: "不知道需求在哪个飞书项目空间：请到「设置 → 飞书项目」里设置默认空间，或到工作台点「刷新」后再试" };
  const text = await runMeegle({ ...fp, timeoutSec: 30 }, ["workitem", "get", `--project-key=${space}`, `--work-item-id=${req.wid}`, "--fields=group_type", "--format=json"], new AbortController().signal);
  const j = parseJson(text);
  if (j === null) return { ok: false, error: text.replace(/^meegle 退出码 \d+\n?/, "").trim().slice(0, 200) || "读取需求失败" };
  const g = parseGroupField(j);
  if (!g.found) return { ok: false, error: "这个需求没有「拉群方式」字段，可能这类工作项不支持建群" };
  if (!g.groupId) {
    // 需求上没配群（如「不拉群」），但你可能自己拉了群：按需求名搜出来给你选，不自动绑定
    // candidates 有值（哪怕是空数组）= 已经搜过了，界面据此区分「没搜」和「没搜到」
    const candidates = req.title?.trim() ? await findChatCandidates(lark, req.title).catch(() => []) : undefined;
    return { ok: true, none: true, how: g.how, ...(candidates ? { candidates } : {}) };
  }
  const info = await chatInfo(lark ?? { bin: "lark-cli" }, g.groupId).catch(() => ({}) as { name?: string; status?: string });
  return { ok: true, groupId: g.groupId, how: g.how, name: info.name, status: info.status, link: chatLink(g.groupId) };
}
