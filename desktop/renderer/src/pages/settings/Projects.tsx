import { useEffect, useState } from "react";
import type { AppState } from "../../../../shared/api";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { useConfigEditor } from "../../lib/configEdit";
import type { IntegrationStatusDTO } from "../../../../shared/api";

type Status = Awaited<ReturnType<typeof api.feishuProjectStatus>>;

export function Switch({ on, onChange, testid }: { on: boolean; onChange: (v: boolean) => void; testid?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} data-testid={testid} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

/** 飞书项目：开关、CLI 路径、是否允许写入（飞书集成卡片在 Office 页里统一展示） */
export function FeishuProjectSection({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const fp = ed.cfg?.integrations?.feishuProject as { bin?: string; write?: boolean } | undefined;
  const enabled = !!fp;
  const [bin, setBin] = useState(fp?.bin ?? "meegle");
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => setBin(fp?.bin ?? "meegle"), [fp?.bin]);

  const check = async () => {
    setChecking(true);
    setStatus(await api.feishuProjectStatus());
    setChecking(false);
  };
  useEffect(() => {
    if (enabled) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fp?.bin]);

  const run = async (fn: (c: Record<string, any>) => void) => {
    setErr("");
    const r = await ed.update(fn);
    if (!r.ok) setErr(r.error ?? "保存失败");
  };

  return (
    <>
      <div className="channel-card" data-testid="feishu-project-card">
        <div className="channel-logo feishu">
          <Icon name="list" size={22} />
        </div>
        <div className="channel-main">
          <div className="channel-name">
            飞书项目
            {enabled && status && (
              <span className={`chip ${status.installed && status.authenticated ? "ok" : "bad"}`}>
                <span className={`dot ${status.installed && status.authenticated ? "ok" : "bad"}`} />
                {!status.installed ? "未找到 CLI" : status.authenticated ? "已登录" : "未登录"}
              </span>
            )}
            {enabled && checking && <span className="spinner" style={{ marginLeft: 8 }} />}
          </div>
          <div className="muted">通过 meegle CLI 访问，使用它的登录身份。项目管理只能接一个，开启会关闭钉钉项目管理</div>
        </div>
        <Switch
          on={enabled}
          testid="feishu-project-switch"
          onChange={v =>
            void run(c => {
              c.integrations ??= {};
              if (v) {
                c.integrations.feishuProject = { bin: "meegle", write: false };
                delete c.integrations.dingtalkProject; // 项目管理只接入一个
              } else delete c.integrations.feishuProject;
            })
          }
        />
      </div>

      {enabled && (
        <div className="sgroup" style={{ marginBottom: 14 }}>
          <div className="srow">
            <div className="srow-text">
              <div className="srow-title">CLI 路径</div>
              <div className="srow-desc">不在 PATH 里时填写完整路径</div>
            </div>
            <div className="srow-ctl">
              <input
                className="input mono"
                style={{ width: 280 }}
                value={bin}
                onChange={e => setBin(e.target.value)}
                onBlur={() => bin.trim() && bin !== fp?.bin && void run(c => void (c.integrations.feishuProject.bin = bin.trim()))}
              />
              <button className="btn sm" onClick={check} disabled={checking}>
                检测
              </button>
            </div>
          </div>
          <div className="srow">
            <div className="srow-text">
              <div className="srow-title">允许写入</div>
              <div className="srow-desc">评论、创建 / 修改工作项；每次需确认</div>
            </div>
            <div className="srow-ctl">
              <Switch on={!!fp?.write} testid="feishu-project-write" onChange={v => void run(c => void (c.integrations.feishuProject.write = v))} />
            </div>
          </div>
        </div>
      )}

      {enabled && status && !(status.installed && status.authenticated) && <div className="inline-note">{status.detail ?? "meegle 不可用"}</div>}
      {err && <div className="inline-warn">{err}</div>}
      {enabled && status?.authenticated && (
        <div className="muted" style={{ marginBottom: 14 }}>
          已连接 {status.host}
        </div>
      )}

    </>
  );
}

/** 钉钉项目管理：待办任务 + AI 表格，通过 dws CLI（可执行文件路径与「钉钉集成」共用） */
export function DingtalkProjectSection({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const dp = ed.cfg?.integrations?.dingtalkProject as { write?: boolean } | undefined;
  const enabled = !!dp;
  const bin = (ed.cfg?.integrations?.dingtalk?.bin as string | undefined) ?? "dws";
  const [status, setStatus] = useState<IntegrationStatusDTO | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState("");

  const check = async () => {
    setChecking(true);
    setStatus(await api.integrationStatus("dws"));
    setChecking(false);
  };
  useEffect(() => {
    if (enabled) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, bin]);

  const run = async (fn: (c: Record<string, any>) => void) => {
    setErr("");
    const r = await ed.update(fn);
    if (!r.ok) setErr(r.error ?? "保存失败");
  };
  const ready = !!status?.installed && !!status?.authenticated;

  return (
    <>
      <div className="channel-card" data-testid="dingtalk-project-card">
        <div className="channel-logo ding">
          <Icon name="list" size={22} />
        </div>
        <div className="channel-main">
          <div className="channel-name">
            钉钉项目管理
            {enabled && status && (
              <span className={`chip ${ready ? "ok" : "bad"}`}>
                <span className={`dot ${ready ? "ok" : "bad"}`} />
                {!status.installed ? "未找到 CLI" : status.authenticated ? "已登录" : "未登录"}
              </span>
            )}
            {enabled && checking && <span className="spinner" style={{ marginLeft: 8 }} />}
          </div>
          <div className="muted">待办任务 + AI 表格，通过 dws CLI 访问，使用它的登录身份。项目管理只能接一个，开启会关闭飞书项目</div>
        </div>
        <Switch
          on={enabled}
          testid="dingtalk-project-switch"
          onChange={v =>
            void run(c => {
              c.integrations ??= {};
              if (v) {
                c.integrations.dingtalkProject = { write: false };
                delete c.integrations.feishuProject; // 项目管理只接入一个
              } else delete c.integrations.dingtalkProject;
            })
          }
        />
      </div>

      {enabled && (
        <div className="sgroup" style={{ marginBottom: 14 }}>
          <div className="srow">
            <div className="srow-text">
              <div className="srow-title">允许写入</div>
              <div className="srow-desc">创建 / 修改待办、评论、写 AI 表格记录；每次需确认，不支持删除</div>
            </div>
            <div className="srow-ctl">
              <Switch on={!!dp?.write} testid="dingtalk-project-write" onChange={v => void run(c => void (c.integrations.dingtalkProject.write = v))} />
            </div>
          </div>
        </div>
      )}
      {enabled && status && !ready && <div className="inline-note">{status.detail ?? "dws 不可用"}</div>}
      {err && <div className="inline-warn">{err}</div>}
    </>
  );
}
