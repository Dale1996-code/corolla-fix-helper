import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.js",
    // Vitest's default is 5000ms per test. That is far too tight here: the
    // heaviest page suites (SearchPagePagination, SearchPage, UrlViewState)
    // take 40-70s for the FILE, and individual Testing Library waits inside
    // them routinely brush the 5s mark on a loaded machine. The symptom was a
    // suite that failed 2-9 tests per run with a DIFFERENT set each time and
    // never an assertion error -- always a bare "Test timed out in 5000ms" --
    // while CI's faster runner stayed green. A red suite nobody trusts is
    // worse than a slow one, so the budget is set where a genuine hang is
    // still caught but machine load is not reported as a product failure.
    testTimeout: 30000,
    // beforeEach/afterEach render and cleanup share the same problem.
    hookTimeout: 30000,
  },
});
