import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration
 * 
 * Run tests:
 *   npx playwright test
 * 
 * Run tests in headed mode:
 *   npx playwright test --headed
 * 
 * Run specific test file:
 *   npx playwright test api/auth.spec.ts
 */

export default defineConfig({
  testDir: './tests',

  /* 全局登录一次，Cookie 存成 storageState 供各用例复用（避免登录限流把用例打成 skip） */
  globalSetup: require.resolve('./global-setup'),

  /* Run tests in files in parallel */
  fullyParallel: true,
  
  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,
  
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  
  /* Opt out of parallel tests on CI */
  workers: process.env.CI ? 1 : undefined,
  
  /* Reporter to use */
  reporter: [
    ['html', { open: 'never' }],
    ['list']
  ],
  
  /* Shared settings for all the projects below */
  use: {
    /* Base URL to use in actions like `await page.goto('/')` */
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    
    /* Collect trace when retrying the failed test */
    trace: 'on-first-retry',
    
    /* Screenshot on failure */
    screenshot: 'only-on-failure',
    
    /* Video on failure */
    video: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    /* API Tests - no browser needed */
    {
      name: 'api',
      testMatch: /api\/.*\.spec\.ts$/,
    },
    /* UI Tests - use system Chrome if available */
    {
      name: 'chromium',
      testMatch: /ui\/.*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        // 复用 globalSetup 的登录态，避免每条用例各自登录触发限流
        storageState: './.auth/state.json',
        // Use system Chrome if Playwright browsers not installed
        channel: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ? 'chrome' : undefined,
      },
    },
    {
      name: 'firefox',
      testMatch: /ui\/.*\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testMatch: /ui\/.*\.spec\.ts$/,
      use: { ...devices['Desktop Safari'] },
    },
    /* Test against mobile viewports */
    {
      name: 'Mobile Chrome',
      testMatch: /ui\/.*\.spec\.ts$/,
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      testMatch: /ui\/.*\.spec\.ts$/,
      use: { ...devices['iPhone 12'] },
    },
  ],

  /* Run local dev server before starting the tests (disabled for local testing) */
  // webServer: {
  //   command: 'pnpm dev',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  //   timeout: 120000,
  // },
});
