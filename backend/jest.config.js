/**
 * Unit tests: fast, hermetic, no Redis and no sockets.
 * Integration tests live in tests/integration and use jest.integration.config.js.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/tests/unit'],
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 10000,
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
