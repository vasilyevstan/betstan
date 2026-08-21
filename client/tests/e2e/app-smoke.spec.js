const { test, expect } = require('@playwright/test');
const authCopy = require('../../src/pages/auth/authCopy.json');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createShellMockState, installAppApiMocks } = require('./support/mockAppApi');

const prepareShell = async (page, overrides = {}) => {
  await installFakeEventSource(page);
  const state = createShellMockState(overrides);
  await installAppApiMocks(page, state);
  return state;
};

test('home page responds and renders shell', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await prepareShell(page);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('Create account');
  await expect(page.locator('body')).toContainText('Log in');
  expect(pageErrors).toEqual([]);
});

test('variant query param keeps app functional', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await prepareShell(page);

  await page.goto('/?ui=v3', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('Create account');
  expect(pageErrors).toEqual([]);
});

test('signup submit does not crash UI', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await prepareShell(page, { signupError: 'Signup smoke request rejected' });

  await page.goto('/signup', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: authCopy.signup.title })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('qa-smoke');
  await page.getByLabel('Password', { exact: true }).fill('Password123!');
  await page.getByRole('button', { name: authCopy.signup.submit, exact: true }).click();

  await expect(page.getByText('Signup smoke request rejected')).toBeVisible();
  await expect(page.locator('body')).not.toContainText("Cannot read properties of undefined (reading 'map')");
  expect(pageErrors).toEqual([]);
});

test('login submit does not crash UI', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await prepareShell(page, { loginError: 'Login smoke request rejected' });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: authCopy.login.title })).toBeVisible();
  await page.getByLabel('Username or email').fill('qa-invalid');
  await page.getByLabel('Password', { exact: true }).fill('invalid-password');
  await page.getByRole('button', { name: authCopy.login.submit, exact: true }).click();

  await expect(page.getByText('Login smoke request rejected')).toBeVisible();
  await expect(page.locator('body')).not.toContainText("Cannot read properties of undefined (reading 'map')");
  expect(pageErrors).toEqual([]);
});

test('auth pages fit a mobile viewport', async ({ page }) => {
  await prepareShell(page);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const { path, title } of [
    { path: '/login', title: authCopy.login.title },
    { path: '/signup', title: authCopy.signup.title },
  ]) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
