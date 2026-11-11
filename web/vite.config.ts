import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = Number(process.env.PORT ?? 8787);
const webPort = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true, // fail loudly instead of silently moving to another port
    open: false,
    proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
