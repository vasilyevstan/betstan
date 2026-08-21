const { defineConfig } = require('@playwright/test');

const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
const localWebServer = process.env.E2E_BASE_URL
  ? undefined
  : {
      command: 'CI=1 BROWSER=none npm start',
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
    };

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60 * 1000,
  expect: {
    timeout: 10 * 1000,
  },
  webServer: localWebServer,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
});
