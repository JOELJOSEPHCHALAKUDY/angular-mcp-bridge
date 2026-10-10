import { test, expect, type Page } from '@playwright/test';

async function openProjectForm(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Angular integration lab open_lab/ }).click();
  await page.getByRole('button', { name: 'Run tool', exact: false }).click();
  const view = page.frameLocator('iframe');
  await expect(view.getByRole('heading', { name: 'Explore the bridge.' })).toBeVisible();
  await expect(view.locator('.environment')).toContainText('lab_selection ready');
  const form = view.locator('project-tool-form');
  await expect(form.getByRole('textbox', { name: 'Project ID', exact: true })).toBeVisible();
  return form;
}

test('native FormRoot validates, focuses the invalid FormField, and submits through MCP', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const form = await openProjectForm(page);
  const input = form.getByRole('textbox', { name: 'Project ID', exact: true });
  await expect(form.locator('form')).toHaveAttribute('novalidate', '');
  await input.fill(''); await form.getByRole('button', { name: 'Load project', exact: true }).click();
  await expect(input).toBeFocused(); await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('#project-form-id-errors')).not.toHaveText('');
  await input.fill('atlas'); await form.getByRole('button', { name: 'Load project', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Loaded Atlas workspace.');
  await expect(input).toHaveValue('atlas'); await expect(input).toHaveAttribute('aria-invalid', 'false');
  expect(errors).toEqual([]);
});

test('native form reports a server error and retries unchanged input without an unhandled DOM rejection', async ({ page }) => {
  let rejected = false; const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/mcp', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      if (!rejected && body?.method === 'tools/call' && body.params?.name === 'get_project') {
        rejected = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id,
          result: { resultType: 'complete', content: [{ type: 'text', text: 'Temporary project service failure' }], isError: true },
        }) });
        return;
      }
    }
    await route.continue();
  });
  const form = await openProjectForm(page), input = form.getByRole('textbox', { name: 'Project ID', exact: true });
  await form.getByRole('button', { name: 'Load project', exact: true }).click();
  await expect(form.getByRole('alert')).toHaveText('Temporary project service failure');
  await expect(input).toHaveValue('atlas'); await form.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Loaded Atlas workspace.');
  await expect(form.getByRole('alert')).toHaveCount(0); await expect(input).toHaveValue('atlas');
  expect(rejected).toBe(true); expect(errors).toEqual([]);
});
