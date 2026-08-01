const { test, expect } = require('@playwright/test');

test('OCI signup, logout, login, and navigation journey', async ({ page }) => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const username = `oci-smoke-${suffix}`.slice(0, 40);
  const password = `Oc1-${suffix}`.slice(0, 20);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('BetStan');
  await page.getByTitle('Create account').click();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByTitle('Log out')).toBeVisible();

  await page.getByTitle('My bets').click();
  await expect(page).toHaveURL(/\/bets/);
  await page.getByTitle('Backoffice').click();
  await expect(page).toHaveURL(/\/backoffice/);

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
