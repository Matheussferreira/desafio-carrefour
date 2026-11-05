import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/tests/integration/**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/integration/setup.ts'],
  testTimeout: 60_000,
};

export default config;
