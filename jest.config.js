module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterEnv: [
    'aws-cdk-lib/testhelpers/jest-autoclean',
    '<rootDir>/test/setup.ts',
  ],
  // All AWS I/O is mocked (aws-sdk-client-mock), so these are pure in-memory
  // unit tests. Running in a single worker avoids the "worker process failed to
  // exit gracefully" warning, which was a worker-pool teardown artifact (a
  // lingering keep-alive handle between suites) rather than a real leak in the
  // code — a serial run is fully clean and no suite leaks in isolation. This is
  // preferred over forceExit, which would mask teardown issues instead of
  // avoiding them.
  maxWorkers: 1,
};
