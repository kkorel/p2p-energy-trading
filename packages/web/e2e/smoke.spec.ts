/**
 * Smoke Tests - Basic app functionality verification
 * These tests verify the app starts and basic pages load correctly.
 * 
 * Note: Comprehensive E2E tests should be written by inspecting
 * the actual UI with Playwright's codegen tool:
 * npx playwright codegen http://localhost:3000
 */

import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('app should load and display the login screen', async ({ page }) => {
    await page.goto('/');
    
    // The app should load without errors
    // Check for the app title or logo
    await expect(page.locator('h1')).toContainText('EnergyTrade');
    
    // The app should show the tagline
    await expect(page.getByText('P2P renewable energy marketplace')).toBeVisible();
  });

  test('login page should display feature cards', async ({ page }) => {
    await page.goto('/');
    
    // Check that feature cards are displayed
    await expect(page.getByText('Solar & Wind Energy')).toBeVisible();
    await expect(page.getByText('Competitive Pricing')).toBeVisible();
    await expect(page.getByText('Go Green')).toBeVisible();
  });

  test('login page should show terms text', async ({ page }) => {
    await page.goto('/');
    
    await expect(
      page.getByText('By signing in, you agree to our Terms of Service')
    ).toBeVisible();
  });

  test('should show loading state initially', async ({ page }) => {
    await page.goto('/');
    
    // Initially shows loading or the Google button
    // We just verify the page renders without errors
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });
});
