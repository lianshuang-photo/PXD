import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { uxpPlugin } from "./vite-plugin-uxp.js";

export default defineConfig({
  plugins: [react(), uxpPlugin()],
  root: "src",
  base: "./",
  publicDir: false,
  server: {
    port: 5173,
    open: true
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2020",
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.resolve(__dirname, "src/index.html"),
      output: {
        format: "iife",
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]"
      }
    }
  }
});
