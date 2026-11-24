import { useEffect, useRef, useState } from "react";
import type { AppState } from "../../../shared/api";
import { api } from "../api";
import { Icon } from "../components/Icon";
/** 钉钉：消息通道与项目管理都还没接入，先占位 */
export function DingTalkPlaceholders() {
  return (
    <>
      <div className="channel-card dim">
        <div className="channel-logo ding">
          <Icon name="plug" size={22} />
        </div>
        <div className="channel-main">
          <div className="channel-name">
            钉钉消息通道 <span className="chip">待接入</span>
          </div>
          <div className="muted">钉钉消息通道：开发中</div>
        </div>
      </div>
    </>
  );
}

export function ChannelLogs({ state }: { state: AppState }) {
  const [logs, setLogs] = useState<string[]>(state.channel.logs);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => api.onChannelLog(l => setLogs(ls => [...ls.slice(-499), l])), []);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs]);
  return (
    <>
      <div className="section-title">通道运行日志</div>
      <pre className="log" ref={box}>
        {logs.length ? logs.join("\n") : "（暂无日志）"}
      </pre>
    </>
  );
}
