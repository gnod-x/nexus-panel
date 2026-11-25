import { defineConfig, devices } from "@playwright/test";
const artifactRoot = process.env.E2E_ARTIFACT_ROOT || "artifacts/home-refresh";

export default defineConfig({
  testDir: "./tests/e2e",
  // Extended audit has its own server, database, browser engines and report paths.
  testIgnore: ["**/audit-ui.spec.ts"],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: artifactRoot + "/baseline-playwright",
  reporter: [["list"], ["json", { outputFile: artifactRoot + "/baseline-results.json" }], ["html", { outputFolder: artifactRoot + "/baseline-html", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: "npm run build && DATABASE_PATH=:memory: NODE_ENV=production HOST=127.0.0.1 PORT=4173 npm start",
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
