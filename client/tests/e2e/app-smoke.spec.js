const { test, expect } = require('@playwright/test');

test('home page responds and renders shell', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('Create account');
  await expect(page.locator('body')).toContainText('Log in');
  expect(pageErrors).toEqual([]);
});

test('variant query param keeps app functional', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?ui=v3', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('Create account');
  expect(pageErrors).toEqual([]);
});

test('signup submit does not crash UI', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/signup', { waitUntil: 'domcontentloaded' });
  const inputs = page.locator('input');
  await inputs.nth(0).fill(`qa+${Date.now()}@betstan.xyz`);
  await inputs.nth(1).fill('Password123!Password123!');
  await page.getByRole('button', { name: 'Sign Up' }).click();

  await expect(page.locator('body')).not.toContainText("Cannot read properties of undefined (reading 'map')");
  expect(pageErrors).toEqual([]);
});

test('login submit does not crash UI', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const inputs = page.locator('input');
  await inputs.nth(0).fill('qa-invalid@betstan.xyz');
  await inputs.nth(1).fill('invalid-password');
  await page.getByRole('button', { name: /sign (in|up)/i }).click();

  await expect(page.locator('body')).not.toContainText("Cannot read properties of undefined (reading 'map')");
  expect(pageErrors).toEqual([]);
});
