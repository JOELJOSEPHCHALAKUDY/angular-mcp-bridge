import { expect, test } from '@playwright/test';
import { inspectorTab, selectInspectorTab, type InspectorTabName } from './inspector.js';

test('Angular Aria inspector tabs accept pointer selection after scrolling past the sandboxed iframe', async ({ page }) => {
  await page.goto('/');
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Projects.', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: /ARGUMENTS/ }).fill('{"status":"ready"}');
  const run = page.getByRole('button', { name: 'Run tool', exact: false });
  await run.click();
  await expect(run).toBeEnabled();

  const names: InspectorTabName[] = ['Resources', 'Fixtures', 'Prompts', 'View tools', 'Model context', 'Tool result', 'Events'];
  for (const name of names) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(inspectorTab(page, name)).not.toBeInViewport();
    await selectInspectorTab(page, name);
    await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
    await expect(page.getByRole('tabpanel', { name: name === 'Events' ? /^Events/ : name, exact: name !== 'Events' })).toBeVisible();
  }
});

test('Angular Aria inspector tabs support keyboard selection and named panels', async ({ page }) => {
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Protocol inspector' });
  await expect(tabs).toBeVisible();
  const events = tabs.getByRole('tab', { name: /^Events/ });
  const result = tabs.getByRole('tab', { name: 'Tool result', exact: true });
  await events.focus(); await events.press('ArrowRight');
  await expect(result).toBeFocused();
  await expect(events).toHaveAttribute('aria-selected', 'true');
  await result.press('Enter');
  await expect(result).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Tool result', exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: /^Events/ })).toHaveCount(0);
  await result.press('ArrowLeft'); await events.press('Enter');
  await expect(events).toHaveAttribute('aria-selected', 'true');
});

test('schema fields associate errors and retain predictable focus during array edits', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Angular input schema inspect_schema/ }).click();
  await page.getByRole('combobox', { name: 'Input mode' }).selectOption('form');
  const limit = page.getByRole('spinbutton', { name: 'limit *', exact: true });
  await limit.fill('9');
  await expect(limit).toHaveAttribute('aria-invalid', 'true');
  await expect(limit).toHaveAttribute('aria-required', 'true');
  const errorId = await limit.getAttribute('aria-describedby');
  expect(errorId).toBeTruthy();
  await expect(page.locator(`[id="${errorId!.split(' ').find(id => id.endsWith('-errors'))}"]`)).toContainText('maximum');
  await limit.fill('2'); await expect(limit).toHaveAttribute('aria-invalid', 'false');
  const add = page.getByRole('button', { name: 'Add tags item', exact: true });
  await add.click();
  const first = page.getByRole('textbox', { name: 'tags[0]', exact: true });
  await expect(first).toBeFocused(); await first.fill('first');
  await add.click();
  const second = page.getByRole('textbox', { name: 'tags[1]', exact: true });
  await expect(second).toBeFocused(); await second.fill('second');
  const stableId = await second.getAttribute('id');
  await page.getByRole('button', { name: 'Remove tags item 0', exact: true }).click();
  await expect(first).toHaveValue('second'); await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('id', stableId!);
  await page.getByRole('button', { name: 'Remove tags item 0', exact: true }).click();
  await expect(add).toBeFocused();
  await page.getByRole('button', { name: 'Run tool', exact: false }).click();
  await expect(page.locator('.sr-only[role="status"]')).toContainText('completed');
});
