/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/*.test.ts',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/packages/web/e2e/',  // Playwright E2E tests - use npx playwright test
    '/packages/web/src/__tests__/',  // Frontend tests - use npm test -w @p2p/web
  ],
  moduleNameMapper: {
    '^@p2p/shared$': '<rootDir>/packages/shared/src/index.ts',
    '^@p2p/shared/(.*)$': '<rootDir>/packages/shared/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.base.json',
    }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    '!packages/*/src/**/*.d.ts',
    '!packages/*/src/**/index.ts',
    '!packages/shared/src/generated/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true,
  testTimeout: 30000, // 30 seconds for async tests
  
  // Run tests sequentially to avoid database race conditions
  maxWorkers: 1,
  
  // Setup files
  setupFilesAfterEnv: ['<rootDir>/packages/shared/src/tests/setup.ts'],
  
  // Global setup/teardown for database
  globalSetup: '<rootDir>/packages/shared/src/tests/globalSetup.ts',
  globalTeardown: '<rootDir>/packages/shared/src/tests/globalTeardown.ts',
};
