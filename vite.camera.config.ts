import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  build: {
    outDir: "dist/assets",
    emptyOutDir: false,
    sourcemap: true,
    target: "es2020",
    lib: {
      entry: path.resolve(__dirname, "src/cameraRuntime.ts"),
      name: "PxdCameraRuntime",
      formats: ["iife"],
      fileName: () => "camera-runtime.js"
    }
  }
});
