// 打包前准备「随包 CLI」：把飞书 lark-cli、飞书项目 meegle、钉钉 dws 的可执行文件收进 build/cli，
// 由 electron-builder 的 extraResources 拷到安装目录的 resources/cli，同事不用装 Node / npm。
//
// 用法：node scripts/bundle-cli.mjs [--force]
// 已经收齐就跳过；加 --force 重新下载最新版。产物不进 git（build/cli 在 .gitignore 里）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build", "cli");
const force = process.argv.includes("--force");

const win = process.platform === "win32";
const ext = win ? ".exe" : "";
const plat = `${process.platform}-${process.arch}`;

// 包名 → 包里可执行文件的位置 → 在 build/cli 里的名字
const TOOLS = [
  { pkg: "@larksuite/cli", from: `bin/lark-cli${ext}`, to: `lark-cli${ext}` },
  { pkg: "@lark-project/meegle", from: `bin/meegle-${plat}${ext}`, to: `meegle${ext}` },
  { pkg: "dingtalk-workspace-cli", from: `vendor/dws${ext}`, to: `dws${ext}` },
];

const have = () => TOOLS.every(t => fs.existsSync(path.join(out, t.to)));
if (!force && have()) {
  console.log("[bundle-cli] build/cli 已收齐，跳过（要更新版本请加 --force）");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-cli-"));
try {
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "mh-cli-bundle", private: true }));
  console.log("[bundle-cli] 正在下载官方 CLI（lark-cli / meegle / dws）…");
  // 这几个包的 postinstall 会下载对应平台的可执行文件，所以不能加 --ignore-scripts
  // 有的包（dws）的 postinstall 还会往「用户主目录」里装一堆技能（~/.agents/skills/dingtalk-*），
  // 污染开发机、也会让没用钉钉的人看到一堆钉钉技能。所以把 HOME 指到临时目录里装，装完一起删掉；
  // npm 缓存仍用真实的位置，不会每次重新下载。
  const cache = spawnSync("npm config get cache", { encoding: "utf8", shell: true }).stdout.trim();
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...(cache ? { npm_config_cache: cache } : {}) };
  const r = spawnSync(`npm install --no-audit --no-fund ${TOOLS.map(t => t.pkg).join(" ")}`, { cwd: tmp, stdio: "inherit", shell: true, env });
  if (r.status !== 0) throw new Error("npm install 失败，请检查网络后重试");

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const versions = {};
  for (const t of TOOLS) {
    const dir = path.join(tmp, "node_modules", ...t.pkg.split("/"));
    const src = path.join(dir, t.from);
    if (!fs.existsSync(src)) throw new Error(`${t.pkg} 里没有找到 ${t.from}（当前平台 ${plat} 可能不受支持）`);
    fs.copyFileSync(src, path.join(out, t.to));
    if (!win) fs.chmodSync(path.join(out, t.to), 0o755);
    versions[t.pkg] = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  }
  fs.writeFileSync(path.join(out, "versions.json"), JSON.stringify({ platform: plat, ...versions }, null, 2));
  const mb = TOOLS.reduce((s, t) => s + fs.statSync(path.join(out, t.to)).size, 0) / 1048576;
  console.log(`[bundle-cli] 完成：${TOOLS.map(t => `${t.pkg}@${versions[t.pkg]}`).join("，")}（共 ${mb.toFixed(0)} MB）`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
