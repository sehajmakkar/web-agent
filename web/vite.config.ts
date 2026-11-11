import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    open: false,
    proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
