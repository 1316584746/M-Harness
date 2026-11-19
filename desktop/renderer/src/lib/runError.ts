/** 把一次运行失败的原始报错，翻译成「出了什么事 + 该怎么办」 */
export interface RunErrorInfo {
  /** 一句话说明发生了什么 */
  title: string;
  /** 补充说明（可选） */
  detail?: string;
  /** 建议怎么处理 */
  hints: string[];
  /** 原始报错（去掉了「外部 Agent 失败：」这类前缀） */
  raw: string;
  /** 用户自己点了停止（不是故障） */
  userAborted?: boolean;
}

const PREFIX = /^(外部 Agent 失败：|运行失败：|Error:\s*)+/;

const rules: Array<{ test: RegExp; make: (raw: string) => Omit<RunErrorInfo, "raw"> }> = [
  {
    test: /未安装 @cursor\/sdk|Cannot find (module|package) '@cursor\/sdk'/i,
    make: () => ({
      title: "没有安装 Cursor SDK，无法启动 Cursor Agent",
      hints: ["在软件所在目录执行 npm i @cursor/sdk（需要 Node 22.13 或更高版本）", "装好后重启软件再试；也可以在模型选择里换成别的 Agent"],
    }),
  },
  {
    test: /无法启动 .+：|spawn .*ENOENT|ENOENT|not recognized as an internal|command not found|找不到命令/i,
    make: raw => ({
      title: "找不到命令行 Agent，没能启动",
      detail: raw.match(/无法启动 [^：]+/)?.[0],
      hints: ["确认对应的命令行工具（codex / cursor-agent / claude）已经安装，并且在终端里能直接运行", "装在特殊位置的话，到「设置 → 模型」里把命令写成完整路径"],
    }),
  },
  {
    test: /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid[ _-]?(api[ _-]?)?key|api[ _-]?key|apikey|authentication|not logged in|未登录|缺少.*Key|缺 Key|没有设置.*Key|CURSOR_API_KEY/i,
    make: () => ({
      title: "API Key 无效、过期或没有设置",
      hints: ["到「设置 → 模型」检查这个 Agent 的 Key，点「刷新」验证一次", "Key 是新生成的话，确认复制完整、没有多余空格"],
    }),
  },
  {
    test: /\b429\b|rate.?limit|too many requests|quota|usage limit|insufficient|余额|额度|限流/i,
    make: () => ({
      title: "触发了限流，或额度已用完",
      hints: ["等一会儿再试", "到对应平台的账单 / 用量页面确认额度是否用完", "也可以换一个模型或 Agent"],
    }),
  },
  {
    test: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network|socket hang up|certificate|TLS|proxy|getaddrinfo|网络/i,
    make: () => ({
      title: "网络连接失败，没连上服务",
      hints: ["检查网络、代理或 VPN 是否正常", "公司网络可能需要先开代理，再重新发送", "服务本身偶尔不稳定，稍后重试"],
    }),
  },
  {
    test: /运行超时|timed? ?out|超时|TimeoutError/i,
    make: () => ({
      title: "运行时间太长，被超时终止了",
      hints: ["任务太大的话，拆成几条小指令分别发", "重试一次；如果每次都超时，检查网络，或换一个更快的模型"],
    }),
  },
  {
    test: /model.*(not found|does not exist|unavailable|invalid)|模型.*(不存在|不可用|不支持)|unknown model/i,
    make: () => ({
      title: "这个模型不可用",
      hints: ["在输入框下方换一个模型", "到「设置 → 模型」刷新模型列表，确认账号有权使用它"],
    }),
  },
  {
    test: /Cursor run (error|expired|cancelled)|status.*(ERROR|EXPIRED)/i,
    make: () => ({
      title: "Cursor 那边运行出错了",
      hints: ["看下面「失败前最后的输出」找原因", "重试一次；反复失败的话，换一个模型，或检查 Cursor 账号状态"],
    }),
  },
  {
    test: /最大步数|max.?steps/i,
    make: () => ({
      title: "用完了允许的最大步数，任务还没做完",
      hints: ["把任务拆小，或者发一句「继续」让它接着做"],
    }),
  },
  {
    test: /退出码 \d+/,
    make: raw => ({
      title: "命令行 Agent 异常退出了",
      detail: raw.match(/\S+ 退出码 \d+/)?.[0],
      hints: ["看下面的原始错误，通常最后几行就是原因", "确认这个命令行工具本身能正常使用（先登录、授权过）"],
    }),
  },
];

/** raw：运行失败时的文字（chatStore 里就是 turn.text）；aborted：这一轮是被中断的 */
export function explainRunError(text: string, aborted = false): RunErrorInfo {
  const raw = text.replace(PREFIX, "").trim();
  if (aborted || /^已中断/.test(raw)) {
    if (/超时/.test(raw)) return { title: "运行超时，已自动停止", hints: ["重试一次，或把任务拆小", "检查网络是否稳定"], raw };
    if (/应用关闭/.test(raw)) return { title: "上次退出软件时这一轮还在运行，已中断", hints: ["重新发送一次指令即可"], raw, userAborted: true };
    return { title: "这一轮已中断", detail: "是你点了「停止」，不是故障。Agent 已经做的修改（如果有）不会自动撤销。", hints: [], raw, userAborted: true };
  }
  for (const r of rules) if (r.test.test(raw)) return { ...r.make(raw), raw };
  return {
    title: "运行失败了",
    detail: raw ? undefined : "没有收到具体的错误信息",
    hints: ["展开「过程」页签，看失败前最后做了什么", "重试一次；反复失败就换一个 Agent 或模型", "需要排查的话，点 trace 查看完整记录"],
    raw,
  };
}
