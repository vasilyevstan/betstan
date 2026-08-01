const path = require('path');

module.exports = {
  testDir: __dirname,
  testMatch: 'oci-live-smoke.spec.js',
  timeout: 90 * 1000,
  expect: {
    timeout: 15 * 1000,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  outputDir: path.resolve(process.env.OCI_E2E_OUTPUT_DIR || 'artifacts/oci-e2e'),
};
