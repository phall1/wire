import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://wire.phall.io",
  // Emit /terminal-osc/133.html (not /terminal-osc/133/index.html) so the bare,
  // no-trailing-slash path is the canonical 200 and the .json twin sits beside
  // it — exactly the URL the agent contract promises (curl .../terminal-osc/133).
  trailingSlash: "never",
  build: { format: "file" },
  vite: {
    plugins: [tailwindcss()],
  },
});
