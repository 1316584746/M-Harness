import { useState } from "react";
import type { AppState, ToolInfo } from "../../../shared/api";
import { DBX_MCP_NAME, dbxBridgeOn, setDbxBridge, type MarketResult } from "../../../shared/plugins";
import { api } from "../api";
import { useConfigEditor } from "./configEdit";

/** DBX 桥接：把 DBX 自带的 MCP 组件接进 Harness，DBX 里装的插件才能被 AI 调用 */
export function useDbxBridge(state: AppState, onChanged: () => void, market: MarketResult | null) {
  const ed = useConfigEditor(state, onChanged);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const mcp = market?.dbx?.mcp;
  const on = dbxBridgeOn(ed.cfg);
  /** 能不能打开：已经配过，或者本机找得到 DBX 的 MCP 组件 */
  const available = on || !!mcp || !!ed.cfg?.mcpServers?.[DBX_MCP_NAME];

  const toggle = (v: boolean) => ed.update(c => setDbxBridge(c, v, mcp));

  const loadTools = async () => {
    const prefix = `mcp__${DBX_MCP_NAME}__`;
    setTools((await api.listTools()).filter(t => t.name.startsWith(prefix)));
  };

  return { on, available, mcp, toggle, tools, loadTools, clearTools: () => setTools(null) };
}
