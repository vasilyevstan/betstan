const { test, expect } = require('@playwright/test');

test('home page responds and renders shell', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('Create account');
  expect(pageErrors).toEqual([]);
});

test('signup submit does not crash UI', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/signup', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email Address').fill(`qa+${Date.now()}@betstan.xyz`);
  await page.getByLabel('Password').fill('Password123!Password123!');
  await page.getByRole('button', { name: 'Sign Up' }).click();

  await expect(page.locator('body')).not.toContainText("Cannot read properties of undefined (reading 'map')");
  expect(pageErrors).toEqual([]);
});

test('login submit does not crash UI', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email Address').fill('qa-invalid@betstan.xyz');
  await page.getByLabel('Password').fill('invalid-password');
  await page.getByRole('button', { name: 'Sign Up' }).click();

  await expect(page.locator('body')).not.toContainText("Cannot read properties of undefined (reading 'map')");
  expect(pageErrors).toEqual([]);
});

