import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure', launchOptions: process.env['BROWSER_EXECUTABLE'] ? { executablePath: process.env['BROWSER_EXECUTABLE'] } : {} },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'npm run preview', url: 'http://127.0.0.1:3100/health', env: { PORT: '3100' }, reuseExistingServer: false, timeout: 30000 },
});
