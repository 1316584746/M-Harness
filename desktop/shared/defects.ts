/** 指派给我的缺陷 / 问题（飞书项目的缺陷、钉钉待办），主进程和界面共用 */

export type DefectSource = "feishu" | "dingtalk";

export interface Defect {
  /** 来源内唯一的 id */
  id: string;
  source: DefectSource;
  title: string;
  /** 空间名（飞书项目） */
  space?: string;
  spaceKey?: string;
  spaceSimple?: string;
  /** 工作项类型：key 用来查流转，名字用来展示（缺陷 / bug 管理） */
  typeKey?: string;
  typeName?: string;
  /** 当前状态的名字和 key */
  status: string;
  statusKey?: string;
  priority?: string;
  severity?: string;
  /** 提出人 */
  reporter?: string;
  /** 当前负责人 */
  assignees?: string[];
  /** 提出时间 / 最近更新（毫秒时间戳） */
  created?: number;
  updated?: number;
  due?: number;
  url?: string;
  /** 自从我上次打开列表后新来的 */
  isNew?: boolean;
}

export interface DefectsResult {
  /** 是否接了项目管理工具（没接就不显示入口） */
  enabled: boolean;
  source?: DefectSource;
  ok: boolean;
  items: Defect[];
  error?: string;
  /** 某些空间查失败了（其余正常） */
  warnings?: string[];
  /** 登录账号 */
  user?: string;
  /** 取数时间 */
  at: number;
}

export interface DefectTransition {
  id: string;
  name: string;
  /** 这个流转需要填表单（必填字段），本软件填不了，只能去原系统里操作 */
  needsForm?: boolean;
}

export interface DefectTransitions {
  ok: boolean;
  /** 当前状态 */
  current?: string;
  items: DefectTransition[];
  error?: string;
}

export interface DefectActResult {
  ok: boolean;
  error?: string;
}

export const defectKey = (d: Pick<Defect, "source" | "id">) => `${d.source}:${d.id}`;

export const SOURCE_NAME: Record<DefectSource, string> = { feishu: "飞书项目", dingtalk: "钉钉" };
/** 入口按钮上的名字 */
export const ENTRY_NAME: Record<DefectSource, string> = { feishu: "飞书缺陷", dingtalk: "钉钉待办" };

const CLOSED_RE = /关闭|已完成|(?<!未)完成|已取消|取消|终止|已拒绝|拒绝|已解决并关闭|closed|done|abort|cancel|reject|finish/i;
/** 状态是否已经是终态（不再需要我处理） */
export const isClosedStatus = (name: string, key?: string) => CLOSED_RE.test(name) || (!!key && /^(closed|done|abort|archived)$/i.test(key));
