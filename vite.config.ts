import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Renderer build: dist/renderer/index.html + assets.
// Main/preload compilam pelo tsc (tsconfig.node.json → dist/main).
export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "src/renderer/index.html"),
        overlay: path.resolve(__dirname, "src/renderer/overlay.html"),
        annotation: path.resolve(__dirname, "src/renderer/annotation.html"),
        bar: path.resolve(__dirname, "src/renderer/bar.html"),
        recorder: path.resolve(__dirname, "src/renderer/recorder.html"),
        editor: path.resolve(__dirname, "src/renderer/editor.html"),
      },
    },
  },
});
