import { expect, type Locator, type Page } from '@playwright/test';

export type InspectorTabName = 'Events' | 'Tool result' | 'Model context' | 'View tools' | 'Resources' | 'Prompts' | 'Fixtures';

export function inspectorTab(page: Page, name: InspectorTabName): Locator {
  return page.getByRole('tablist', { name: 'Protocol inspector' }).getByRole('tab', {
    name: name === 'Events' ? /^Events/ : name,
    exact: name !== 'Events',
  });
}

export async function selectInspectorTab(page: Page, name: InspectorTabName): Promise<void> {
  const tab = inspectorTab(page, name);
  await tab.scrollIntoViewIfNeeded();
  // Chromium's out-of-process iframe hit region can retain its pre-scroll
  // coordinates until painting. Wait for rendering before sending real input.
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}
