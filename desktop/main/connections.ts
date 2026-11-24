import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONN_FIELDS, DEFAULTS, fieldVisible, isSecretField, validateConnection, type Connection, type ConnectionInput, type ConnKind } from "../shared/connections";

/** 秘密落盘前的加密。正式环境用系统的 safeStorage（Windows DPAPI / macOS 钥匙串），不可用时退回明文并在文件里标出来 */
export interface SecretBox {
  encrypt(s: string): string;
  decrypt(s: string): string;
}

export const plainBox: SecretBox = { encrypt: s => `plain:${s}`, decrypt: s => (s.startsWith("plain:") ? s.slice(6) : s) };

const MAX = 200;

interface Stored extends Omit<Connection, "secretSet"> {}

/**
 * 连接的存储：普通字段在 connections.json，密码等秘密在 connection-secrets.json（加密）。
 * 两个文件都在本软件的数据目录里，不进代码仓库。连接列表只带「有没有设置」；明文只在用户打开编辑框时通过 revealSecrets 取一次。
 */
export class ConnectionStore {
  constructor(
    private dir: string,
    private box: SecretBox = plainBox,
  ) {}

  private get file() {
    return path.join(this.dir, "connections.json");
  }
  private get secretFile() {
    return path.join(this.dir, "connection-secrets.json");
  }

  private readAll(): Stored[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(j?.connections) ? j.connections.filter((c: any) => c && typeof c.id === "string" && CONN_FIELDS[c.kind as ConnKind]) : [];
    } catch {
      return [];
    }
  }

  private readSecrets(): Record<string, Record<string, string>> {
    try {
      const j = JSON.parse(fs.readFileSync(this.secretFile, "utf8"));
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }

  private write(list: Stored[], secrets: Record<string, Record<string, string>>): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ connections: list }, null, 2));
    fs.writeFileSync(this.secretFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }

  private view(c: Stored, secrets: Record<string, Record<string, string>>): Connection {
    const have = secrets[c.id] ?? {};
    return { ...c, secretSet: Object.fromEntries(CONN_FIELDS[c.kind].filter(isSecretField).map(f => [f.key, !!have[f.key]])) };
  }

  list(): Connection[] {
    const s = this.readSecrets();
    return this.readAll().map(c => this.view(c, s));
  }

  get(id: string): Connection | undefined {
    return this.list().find(c => c.id === id);
  }

  /** 取明文秘密（只给主进程里的测试 / 连接用，不通过 IPC 出去） */
  secretsOf(id: string): Record<string, string> {
    const have = this.readSecrets()[id] ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(have)) {
      try {
        out[k] = this.box.decrypt(v);
      } catch {
        /* 解不开（换了电脑 / 用户）就当没设置 */
      }
    }
    return out;
  }

  /** 编辑框里回显用：这个连接已保存的秘密（只含密码 / 令牌这类字段，当前可见的）。只在用户打开编辑框时取一次 */
  revealSecrets(id: string): Record<string, string> {
    const c = this.readAll().find(x => x.id === id);
    if (!c) return {};
    const have = this.secretsOf(id);
    const vals = { ...DEFAULTS[c.kind], ...c.fields };
    const out: Record<string, string> = {};
    for (const d of CONN_FIELDS[c.kind].filter(isSecretField)) if (fieldVisible(d, vals) && have[d.key]) out[d.key] = have[d.key];
    return out;
  }

  /** 新建或更新；返回保存后的连接 */
  save(input: ConnectionInput): Connection {
    const list = this.readAll();
    const secrets = this.readSecrets();
    const prev = input.id ? list.find(c => c.id === input.id) : undefined;
    if (input.id && !prev) throw new Error("这个连接已经不存在了");
    if (prev && prev.kind !== input.kind) throw new Error("保存后不能改连接类型");
    const defs = CONN_FIELDS[input.kind];
    const err = validateConnection(input, prev ? this.view(prev, secrets).secretSet : {});
    if (err) throw new Error(err);
    if (!prev && list.length >= MAX) throw new Error(`最多保存 ${MAX} 个连接`);
    const name = input.name.trim();
    if (list.some(c => c.id !== prev?.id && c.kind === input.kind && c.name === name)) throw new Error(`已经有一个叫「${name}」的连接了，换个名字（可以把环境或机器写进名字里）`);

    // 只保留这一类、并且当前可见的字段，免得切换登录方式后留下无用数据
    const vals = { ...DEFAULTS[input.kind], ...input.fields };
    const fields: Record<string, string> = {};
    for (const d of defs) if (!isSecretField(d) && fieldVisible(d, vals) && vals[d.key] !== undefined) fields[d.key] = String(vals[d.key]).trim();

    const id = prev?.id ?? crypto.randomUUID();
    const mine = { ...(secrets[id] ?? {}) };
    for (const d of defs.filter(isSecretField)) {
      const v = input.secrets?.[d.key];
      if (!fieldVisible(d, vals)) delete mine[d.key];
      else if (v === "") delete mine[d.key];
      else if (v !== undefined) mine[d.key] = this.box.encrypt(v);
    }
    if (Object.keys(mine).length) secrets[id] = mine;
    else delete secrets[id];

    const now = Date.now();
    const rec: Stored = { id, kind: input.kind, name, env: input.env.trim(), machine: input.machine.trim(), note: input.note?.trim() || undefined, enabled: input.enabled ?? prev?.enabled ?? true, fields, createdAt: prev?.createdAt ?? now, updatedAt: now };
    this.write(prev ? list.map(c => (c.id === id ? rec : c)) : [...list, rec], secrets);
    return this.view(rec, secrets);
  }

  setEnabled(id: string, enabled: boolean): void {
    const list = this.readAll();
    if (!list.some(c => c.id === id)) throw new Error("这个连接已经不存在了");
    this.write(
      list.map(c => (c.id === id ? { ...c, enabled, updatedAt: Date.now() } : c)),
      this.readSecrets(),
    );
  }

  remove(id: string): { ok: boolean; usedBy?: string[] } {
    const list = this.readAll();
    if (!list.some(c => c.id === id)) return { ok: false };
    // 被内嵌终端引用的服务器连接，不让直接删
    const users = list.filter(c => c.kind === "terminal" && c.fields.mode === "server" && c.fields.serverId === id).map(c => c.name);
    if (users.length) return { ok: false, usedBy: users };
    const secrets = this.readSecrets();
    delete secrets[id];
    this.write(
      list.filter(c => c.id !== id),
      secrets,
    );
    return { ok: true };
  }
}
