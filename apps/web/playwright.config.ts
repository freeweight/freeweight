import { defineConfig, devices } from "@playwright/test";

const PORT = 4174;

// Browser smoke tests run against a mock build: no gateway, no network. Not part of CI; run with `npm run e2e`.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  // Two at a time: the tests measure layout as it loads, and a crowded machine makes those numbers noisy.
  workers: 2,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `npm run build:mock && npx vite preview --outDir dist-mock --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
