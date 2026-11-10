import { defineConfig } from "vitest/config";

// Unit tests cover plain modules (formatters, the API client, parsers) and run in Node with no browser,
// no network and none of the app's build plugins.
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
