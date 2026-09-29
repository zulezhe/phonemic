import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 14333,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/phone/**"],
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
