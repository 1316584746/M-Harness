import type { AppState } from "../../../../shared/api";
import { ChannelLogs, DingTalkPlaceholders, FeishuChannel } from "../Channels";
import { DingTalkIntegration, FeishuIntegration } from "./Integrations";
import { DingtalkProjectSection, FeishuProjectSection } from "./Projects";

/** 办公集成：飞书 / 钉钉各一组——CLI 登录状态、消息通道、项目管理 */
export function Office({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  return (
    <div className="page" data-testid="office-page">
      <div className="page-head">
        <h1>办公集成</h1>
      </div>

      <div className="section-title">飞书</div>
      <FeishuIntegration state={state} onChanged={onChanged} />
      <FeishuChannel state={state} onChanged={onChanged} />
      <FeishuProjectSection state={state} onChanged={onChanged} />

      <div className="section-title">钉钉</div>
      <DingTalkIntegration />
      <DingTalkPlaceholders />
      <DingtalkProjectSection state={state} onChanged={onChanged} />

      <ChannelLogs state={state} />
    </div>
  );
}
