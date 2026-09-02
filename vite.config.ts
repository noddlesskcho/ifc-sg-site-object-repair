import { defineConfig } from "vite";

export default defineConfig({
  // "/" works for local dev/preview (always served from the domain root) and is what makes
  // import.meta.env.BASE_URL usable as a reliable absolute-from-root prefix (see
  // ifc-worker.ts's SetWasmPath). The GitHub Pages workflow overrides this via GH_PAGES_BASE
  // to the repo's subpath, since a project Pages site isn't served from the domain root.
  base: process.env.GH_PAGES_BASE || "/",
  worker: {
    format: "es"
  },
  test: {
    environment: "jsdom",
    globals: true
  }
});
