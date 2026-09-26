import react from "@vitejs/plugin-react";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react(), wgslVitePlugin()], worker: { format: "es" }, base: "./", server: { port: Number(process.env["BEAM_WEB_PORT"] ?? 5173), strictPort: true } });
