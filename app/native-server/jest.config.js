module.exports = {
  preset: 'ts-jest',
  // Fastify's injection dependency cookie is ESM; Jest 29 needs it transformed
  // even though Node 24 can require it directly. Cover pnpm's two node_modules levels.
  transform: {
    '^.+\\.jsx?$': [
      'ts-jest',
      { tsconfig: { allowJs: true, checkJs: false, module: 'CommonJS', moduleResolution: 'Node' } },
    ],
  },
  transformIgnorePatterns: ['[/\\\\]node_modules[/\\\\](?!\\.pnpm[/\\\\]cookie@|cookie[/\\\\])'],
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  setupFilesAfterEnv: ['<rootDir>/src/test-log-isolation.js'],
  collectCoverage: process.env.JEST_COVERAGE === '1',
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/scripts/**/*'],
  coverageDirectory: 'coverage',
  ...(process.env.JEST_COVERAGE === '1'
    ? {
        coverageThreshold: {
          global: {
            branches: 70,
            functions: 80,
            lines: 80,
            statements: 80,
          },
        },
      }
    : {}),
};
