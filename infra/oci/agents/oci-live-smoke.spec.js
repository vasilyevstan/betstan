const { test, expect } = require('@playwright/test');

test('OCI reusable-user login and navigation journey', async ({ page }) => {
  const allowLegacyAdminUi = process.env.OCI_ALLOW_LEGACY_ADMIN_UI === '1';
  const username =
    process.env.LIVE_ACCEPTANCE_USERNAME || 'betstan-e2e-protected-v2';
  const password = process.env.LIVE_ACCEPTANCE_PASSWORD;
  if (!password) {
    throw new Error('LIVE_ACCEPTANCE_PASSWORD must be set');
  }
  if (password.length < 4 || password.length > 20) {
    throw new Error(
      'LIVE_ACCEPTANCE_PASSWORD must satisfy the 4-20 character signup contract'
    );
  }

  const existingLogin = await page.request.post('/api/auth/login', {
    data: {
      email: username,
      password,
    },
  });
  if (!existingLogin.ok()) {
    expect(existingLogin.status()).toBe(400);
    const accountCreation = await page.request.post('/api/auth/new', {
      data: {
        email: username,
        password,
      },
    });
    if (!accountCreation.ok()) {
      throw new Error(
        `Reusable validation account resolution failed: login=${existingLogin.status()} create=${accountCreation.status()}`
      );
    }
    expect(accountCreation.status()).toBe(201);
  }

  const resolvedUser = await page.request.get('/api/auth/currentuser');
  expect(resolvedUser.ok()).toBeTruthy();
  expect((await resolvedUser.json()).currentUser).toBeTruthy();

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: 'BetStan', exact: true })).toBeVisible();
  await expect(page.getByTitle('Log out')).toBeVisible();

  await page.getByTitle('My bets').click();
  await expect(page).toHaveURL(/\/bets/);
  if (!allowLegacyAdminUi) {
    const backofficeLink = page.getByTitle('Backoffice');
    await expect(backofficeLink).toBeVisible();
    await backofficeLink.click();
    await expect(page).toHaveURL(/\/backoffice/);
    await expect(page.getByRole('heading', { name: 'Backoffice' })).toBeVisible();
    await expect(page.getByText(
      'Administrator access is required to use Backoffice.'
    )).toBeVisible();
  }

  await page.getByTitle('Log out').click();
  await expect(page.getByTitle('Log in')).toBeVisible();
  if (!allowLegacyAdminUi) {
    await expect(page.getByTitle('Backoffice')).toBeVisible();
    await page.getByTitle('Backoffice').click();
    await expect(page.getByText(
      'Log in with an administrator account to use Backoffice.'
    )).toBeVisible();
  }
  await page.getByTitle('Log in').click();
  await page.getByLabel('Username or email').fill(username);
  const passwordInput = page.getByLabel('Password', { exact: true });
  let uiLoginResponse;
  try {
    await passwordInput.fill(password);
    [uiLoginResponse] = await Promise.all([
      page.waitForResponse((response) => {
        const request = response.request();
        return (
          new URL(response.url()).pathname === '/api/auth/login' &&
          request.method() === 'POST'
        );
      }),
      page.getByRole('button', { name: 'Log in', exact: true }).click(),
    ]);
  } finally {
    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill('');
    }
  }
  expect(uiLoginResponse).toBeTruthy();
  expect(uiLoginResponse.ok()).toBeTruthy();
  await expect(page.getByTitle('Log out')).toBeVisible();

  const currentUser = await page.request.get('/api/auth/currentuser');
  expect(currentUser.ok()).toBeTruthy();
  expect(currentUser.headers()['content-type']).toContain('application/json');
  expect((await currentUser.json()).currentUser).toBeTruthy();

  await page.getByTitle('Log out').click();
  await expect(page.getByTitle('Log in')).toBeVisible();
  if (!allowLegacyAdminUi) {
    await expect(page.getByTitle('Backoffice')).toBeVisible();
  }
});
