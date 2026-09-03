import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/embed.ts",
      formats: ["es"],
      fileName: () => "embed.js",
    },
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
