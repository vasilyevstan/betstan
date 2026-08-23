const path = require('path');

module.exports = {
  testDir: __dirname,
  testMatch: 'oci-live-acceptance.spec.js',
  timeout: 15 * 60 * 1000,
  expect: {
    timeout: 100 * 1000,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  outputDir: path.resolve(
    process.env.OCI_E2E_OUTPUT_DIR || 'artifacts/oci-live-acceptance',
  ),
};
