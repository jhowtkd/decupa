import { defineConfig, devices } from "@playwright/test";

// Testes de navegador do Decupa Studio (e2e/*.e2e.ts). Cada teste sobe o
// próprio servidor (CLI real) sobre uma Raiz semeada; o vitest não os pega.
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e\.ts$/,
  outputDir: "test-results/e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // No CI uma segunda tentativa; o teste que só passa nela sai como "flaky" no relatório.
  retries: ci ? 1 : 0,
  forbidOnly: ci,
  reporter: ci
    ? [["list"], ["github"], ["html", { open: "never", outputFolder: "playwright-report" }], ["json", { outputFile: "test-results/e2e-resultado.json" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    acceptDownloads: true,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] },
  },
});
