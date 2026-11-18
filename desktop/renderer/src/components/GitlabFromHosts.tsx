import { useEffect, useState } from "react";
import { api } from "../api";

/** GitLab 连接：「设置 → 代码托管」里已经有 GitLab 令牌时，一键建连接（令牌不经过界面） */
export function GitlabFromHosts({ onDone }: { onDone: () => void }) {
  const [info, setInfo] = useState<{ hasToken: boolean; url: string; exists: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => void api.gitlabHostsInfo().then(setInfo), []);
  if (!info || (!info.hasToken && !err)) return null;
  return (
    <div className="gl-hosts" data-testid="gitlab-from-hosts">
      <span>
        「设置 → 代码托管」里已经配了 GitLab 令牌，可以直接用它连接 <code>{info.url}</code>
      </span>
      <button
        className="btn sm primary"
        data-testid="gitlab-from-hosts-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          const r = await api.connectionFromHosts();
          setBusy(false);
          if (r.ok) onDone();
          else setErr(r.error ?? "创建失败");
        }}
      >
        {busy ? "创建中…" : info.exists ? "用它更新连接" : "一键创建连接"}
      </button>
      {err && <span className="gl-hosts-err">{err}</span>}
    </div>
  );
}