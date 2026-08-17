/**
 * Integration tests run against a REAL Redis and REAL WebSocket servers.
 *
 *   npm run redis:test:up      # from the repo root, starts redis on :6380
 *   npm run test:integration
 *
 * Tests run serially (--runInBand, enforced by maxWorkers) because they share
 * one Redis instance and assert on global matchmaking state.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/*.test.ts'],
  maxWorkers: 1,
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 30000,
  globalSetup: '<rootDir>/tests/helpers/globalSetup.ts',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
