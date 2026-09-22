import react from "@vitejs/plugin-react";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react(), wgslVitePlugin()], worker: { format: "es" }, base: "./", server: { port: 5173, strictPort: true } });
