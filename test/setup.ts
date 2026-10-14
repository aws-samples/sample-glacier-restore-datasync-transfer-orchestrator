/**
 * Global Jest setup.
 *
 * Several handlers and orchestrator steps legitimately log via console.error /
 * warn / info / debug on error and edge-case paths. Many unit tests deliberately
 * drive those paths (e.g. simulating a DynamoDB outage to assert a 500), which
 * floods the test output with real-but-expected log lines and stack traces.
 *
 * We replace those four methods with jest spies so the noise is suppressed while
 * tests run. They remain spies, so any test that wants to assert on logging can
 * still inspect the calls. Real test failures (thrown errors, failed
 * expectations) are unaffected and stay visible. console.log is left untouched.
 */

const SILENCED_METHODS = ["error", "warn", "info", "debug"] as const;

beforeEach(() => {
  for (const method of SILENCED_METHODS) {
    jest.spyOn(console, method).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  for (const method of SILENCED_METHODS) {
    const spy = console[method] as unknown as jest.Mock;
    if (typeof spy?.mockRestore === "function") {
      spy.mockRestore();
    }
  }
});
