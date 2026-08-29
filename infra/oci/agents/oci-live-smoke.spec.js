const { test, expect } = require('@playwright/test');

test('OCI reusable-user login and navigation journey', async ({ page }) => {
  const allowLegacyAdminUi = process.env.OCI_ALLOW_LEGACY_ADMIN_UI === '1';
  const username = process.env.LIVE_ACCEPTANCE_USERNAME || 'betstan-e2e';
  const password = process.env.LIVE_ACCEPTANCE_PASSWORD;
  if (!password) {
    throw new Error('LIVE_ACCEPTANCE_PASSWORD must be set');
  }
  const existingLogin = await page.request.post('/api/auth/login', {
    data: {
      email: username,
      password,
    },
  });
  const accountExists = existingLogin.ok();

  if (!accountExists) {
    expect(existingLogin.status()).toBe(400);
  }

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: 'BetStan', exact: true })).toBeVisible();

  if (!accountExists) {
    await page.getByTitle('Create account').click();
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
  }

  await expect(page.getByTitle('Log out')).toBeVisible();

  await page.getByTitle('My bets').click();
  await expect(page).toHaveURL(/\/bets/);
  if (!allowLegacyAdminUi) {
    await expect(page.getByTitle('Backoffice')).toHaveCount(0);
  }

  await page.getByTitle('Log out').click();
  await expect(page.getByTitle('Log in')).toBeVisible();
  await page.getByTitle('Log in').click();
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByTitle('Log out')).toBeVisible();

  const currentUser = await page.request.get('/api/auth/currentuser');
  expect(currentUser.ok()).toBeTruthy();
  expect(currentUser.headers()['content-type']).toContain('application/json');
  expect((await currentUser.json()).currentUser).toBeTruthy();

  await page.getByTitle('Log out').click();
  await expect(page.getByTitle('Log in')).toBeVisible();
});
