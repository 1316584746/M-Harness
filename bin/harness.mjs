#!/usr/bin/env node
// 开发期入口：用 tsx 直接跑 TypeScript 源码。
// 打包桌面版时改为 esbuild/electron-vite 产物。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const entry = path.join(root, "src", "cli", "index.ts");
const r = spawnSync(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
