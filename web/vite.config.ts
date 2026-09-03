import { defineConfig } from "vite";

export default defineConfig({
  appType: "mpa",
  server: {
    host: "0.0.0.0",
    port: 5174,
    strictPort: true,
    proxy: {
      "/_tuner": "http://127.0.0.1:3000",
      "/skill.md": "http://127.0.0.1:3000",
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
});
