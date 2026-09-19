import { defineConfig } from "vitest/config";

// separado do vite.config.ts (que aponta root=src/renderer p/ o build da UI)
export default defineConfig({
  test: {
    root: __dirname,
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
