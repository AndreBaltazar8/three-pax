import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const chrome = process.env.CHROME_PATH || (existsSync('/home/andre/.local/bin/google-chrome') ? '/home/andre/.local/bin/google-chrome' : undefined);
export default defineConfig({
  testDir: './tests', testMatch: ['**/browser.spec.mjs','**/examples.spec.mjs'], timeout: 120000, workers: 1,
  use: { baseURL: process.env.BASE_URL || 'http://localhost:4186', viewport: { width: 1440, height: 1100 }, headless: true,
    launchOptions: { executablePath: chrome, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } },
  reporter: [['list']],
});
