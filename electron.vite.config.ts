import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import path from "node:path";

const r = (p: string) => path.resolve(__dirname, p);

// 主进程与 preload 统一输出 CJS：沙箱化的 preload 只能是 CJS，主进程同理最省心
const cjs = { format: "cjs" as const, entryFileNames: "[name].cjs", chunkFileNames: "[name]-[hash].cjs" };

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: { input: { index: r("desktop/main/index.ts") }, output: cjs },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: { input: { index: r("desktop/preload/index.ts") }, output: cjs },
    },
  },
  renderer: {
    root: r("desktop/renderer"),
    plugins: [react()],
    build: {
      outDir: r("out/renderer"),
      rollupOptions: { input: r("desktop/renderer/index.html") },
    },
  },
});
