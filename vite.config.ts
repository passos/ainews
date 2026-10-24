import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // test:ssr (scripts/smoke-ssr.ts) uses its own local D1 directory.
      persistState: process.env.AINEWS_SMOKE_STATE
        ? { path: process.env.AINEWS_SMOKE_STATE }
        : undefined,
    }),
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
});
