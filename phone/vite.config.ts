import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 1421,
    fs: { allow: [".."] },
    proxy: {
      "/ws": { target: "ws://127.0.0.1:9420", ws: true },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
