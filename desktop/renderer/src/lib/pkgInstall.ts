import { useCallback, useEffect, useState } from "react";
import type { PluginInstallResult } from "../../../shared/api";
import { api } from "../api";

const MAX = 200 * 1024 * 1024;

export interface PkgMsg {
  ok: boolean;
  text: string;
}

const okText = (r: PluginInstallResult) => `已安装「${r.name ?? r.id}」${r.version ? (/^\d/.test(r.version) ? ` v${r.version}` : ` ${r.version}`) : ""}`;

/** 安装本地选的 / 拖进来的 .dbxp，或链接里的 .dbxp；装完刷新插件列表 */
export function usePackageInstall(reload: (refresh?: boolean, silent?: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<PkgMsg | null>(null);

  useEffect(() => {
    if (!msg?.ok) return;
    const t = setTimeout(() => setMsg(null), 8000);
    return () => clearTimeout(t);
  }, [msg]);

  const files = useCallback(
    async (list: File[]) => {
      if (busy || !list.length) return;
      setBusy(true);
      setMsg(null);
      const texts: string[] = [];
      let ok = true;
      for (const f of list) {
        if (!/\.dbxp$/i.test(f.name)) {
          ok = false;
          texts.push(`「${f.name}」不是 .dbxp 插件包`);
          continue;
        }
        if (f.size > MAX) {
          ok = false;
          texts.push(`「${f.name}」太大（超过 200 MB）`);
          continue;
        }
        const r = await api.pluginInstallPackage(new Uint8Array(await f.arrayBuffer()));
        if (r.ok) texts.push(okText(r));
        else {
          ok = false;
          texts.push(`安装「${f.name}」失败：${r.error ?? "未知错误"}`);
        }
      }
      setMsg({ ok, text: texts.join("；") });
      setBusy(false);
      reload(false, true);
    },
    [busy, reload],
  );

  const url = useCallback(
    async (u: string) => {
      if (busy || !u.trim()) return false;
      setBusy(true);
      setMsg(null);
      const r = await api.pluginInstallUrl(u.trim());
      setMsg(r.ok ? { ok: true, text: okText(r) } : { ok: false, text: `安装失败：${r.error ?? "未知错误"}` });
      setBusy(false);
      reload(false, true);
      return r.ok;
    },
    [busy, reload],
  );

  return { busy, msg, setMsg, files, url };
}

export type PackageInstall = ReturnType<typeof usePackageInstall>;
