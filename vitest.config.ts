import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: {
    '@angular-mcp-bridge/angular/forms': fileURLToPath(new URL('./packages/angular/forms/public-api.ts', import.meta.url)),
    '@angular-mcp-bridge/angular/webmcp': fileURLToPath(new URL('./packages/angular/webmcp/public-api.ts', import.meta.url)),
    '@angular-mcp-bridge/angular': fileURLToPath(new URL('./packages/angular/src/public-api.ts', import.meta.url)),
    '@angular-mcp-bridge/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
    '@angular-mcp-bridge/testing': fileURLToPath(new URL('./packages/testing/src/index.ts', import.meta.url)),
    '@angular-mcp-bridge/server': fileURLToPath(new URL('./packages/server/src/index.ts', import.meta.url)),
  } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 10000 },
});
