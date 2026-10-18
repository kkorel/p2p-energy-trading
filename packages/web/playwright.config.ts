import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for E2E browser tests
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e',
  
  // Run tests in files in parallel
  fullyParallel: true,
  
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,
  
  // Retry on CI only
  retries: process.env.CI ? 2 : 0,
  
  // Opt out of parallel tests on CI for stability
  workers: process.env.CI ? 1 : undefined,
  
  // Reporter to use
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  
  // Shared settings for all projects
  use: {
    // Base URL for navigation
    baseURL: 'http://localhost:3000',
    
    // Collect trace on first retry
    trace: 'on-first-retry',
    
    // Capture screenshot on failure
    screenshot: 'only-on-failure',
    
    // Record video on failure
    video: 'retain-on-failure',
    
    // Timeout for actions (click, fill, etc.)
    actionTimeout: 10000,
    
    // Timeout for navigation
    navigationTimeout: 30000,
  },

  // Test timeout
  timeout: 60000,
  
  // Expect timeout
  expect: {
    timeout: 10000,
  },

  // Configure projects for different browsers and viewports
  // Note: Only chromium is enabled by default. Install other browsers with:
  // npx playwright install webkit firefox
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Mobile Chrome emulation (uses chromium)
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    // Uncomment to enable Safari tests (requires: npx playwright install webkit)
    // {
    //   name: 'mobile-safari',
    //   use: { ...devices['iPhone 13'] },
    // },
  ],

  // Run local dev server before starting the tests
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  
  // Output folder for test artifacts
  outputDir: 'test-results/',
});
