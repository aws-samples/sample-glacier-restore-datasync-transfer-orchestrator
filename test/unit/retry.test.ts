import {
  retryWithBackoff,
  classifyError,
  calculateDelay,
  RetryError,
  RetryConfig,
} from "../../src/orchestrator/utils/retry";

describe("retry utility", () => {
  // Use fake timers to avoid real delays in tests
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const defaultConfig: RetryConfig = {
    maxAttempts: 3,
    baseDelayMs: 1000,
    multiplier: 2,
    maxDelayMs: 4000,
  };

  describe("classifyError", () => {
    describe("throttling errors", () => {
      it.each([
        "ThrottlingException",
        "TooManyRequestsException",
        "RequestLimitExceeded",
        "Throttling",
        "SlowDown",
      ])("classifies %s as throttling", (name) => {
        const error = { name };
        expect(classifyError(error)).toBe("throttling");
      });
    });

    describe("transient errors", () => {
      it.each([
        "InternalError",
        "ServiceUnavailable",
        "RequestTimeout",
        "NetworkingError",
      ])("classifies %s as transient", (name) => {
        const error = { name };
        expect(classifyError(error)).toBe("transient");
      });

      it("classifies HTTP 500 as transient", () => {
        const error = { name: "UnknownError", $metadata: { httpStatusCode: 500 } };
        expect(classifyError(error)).toBe("transient");
      });

      it("classifies HTTP 503 as transient", () => {
        const error = { name: "UnknownError", $metadata: { httpStatusCode: 503 } };
        expect(classifyError(error)).toBe("transient");
      });

      it("classifies statusCode 500 as transient", () => {
        const error = { name: "UnknownError", statusCode: 500 };
        expect(classifyError(error)).toBe("transient");
      });
    });

    describe("non-retryable errors", () => {
      it.each([
        "AccessDenied",
        "NoSuchKey",
        "InvalidRequest",
        "NoSuchBucket",
        "InvalidObjectState",
      ])("classifies %s as non-retryable", (name) => {
        const error = { name };
        expect(classifyError(error)).toBe("non-retryable");
      });

      it("classifies unknown errors as non-retryable", () => {
        const error = { name: "SomeRandomError" };
        expect(classifyError(error)).toBe("non-retryable");
      });

      it("classifies non-object errors as non-retryable", () => {
        expect(classifyError("string error")).toBe("non-retryable");
        expect(classifyError(null)).toBe("non-retryable");
        expect(classifyError(undefined)).toBe("non-retryable");
        expect(classifyError(42)).toBe("non-retryable");
      });
    });

    describe("error code extraction", () => {
      it("reads error code from 'code' property", () => {
        const error = { code: "ThrottlingException" };
        expect(classifyError(error)).toBe("throttling");
      });

      it("reads error code from 'Code' property", () => {
        const error = { Code: "ThrottlingException" };
        expect(classifyError(error)).toBe("throttling");
      });

      it("prefers 'name' over 'code'", () => {
        const error = { name: "AccessDenied", code: "ThrottlingException" };
        expect(classifyError(error)).toBe("non-retryable");
      });
    });
  });

  describe("calculateDelay", () => {
    it("returns baseDelayMs for attempt 0", () => {
      expect(calculateDelay(0, defaultConfig)).toBe(1000);
    });

    it("doubles delay for each subsequent attempt", () => {
      expect(calculateDelay(1, defaultConfig)).toBe(2000);
      expect(calculateDelay(2, defaultConfig)).toBe(4000);
    });

    it("caps delay at maxDelayMs", () => {
      expect(calculateDelay(3, defaultConfig)).toBe(4000);
      expect(calculateDelay(10, defaultConfig)).toBe(4000);
    });

    it("works with different configurations", () => {
      const config: RetryConfig = {
        maxAttempts: 5,
        baseDelayMs: 2000,
        multiplier: 2,
        maxDelayMs: 8000,
      };
      expect(calculateDelay(0, config)).toBe(2000);
      expect(calculateDelay(1, config)).toBe(4000);
      expect(calculateDelay(2, config)).toBe(8000);
      expect(calculateDelay(3, config)).toBe(8000); // capped
    });
  });

  describe("retryWithBackoff", () => {
    it("returns result on first successful attempt", async () => {
      const operation = jest.fn().mockResolvedValue("success");

      const result = await retryWithBackoff(operation, defaultConfig, "test-op");

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("retries on throttling errors and succeeds", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ name: "ThrottlingException" })
        .mockResolvedValue("success");

      const promise = retryWithBackoff(operation, defaultConfig, "test-op");
      // Advance past the first retry delay
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("retries on transient errors and succeeds", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ name: "ServiceUnavailable" })
        .mockResolvedValue("success");

      const promise = retryWithBackoff(operation, defaultConfig, "test-op");
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("throws immediately on non-retryable errors", async () => {
      const operation = jest
        .fn()
        .mockRejectedValue({ name: "AccessDenied" });

      await expect(
        retryWithBackoff(operation, defaultConfig, "test-op")
      ).rejects.toThrow(RetryError);

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("throws RetryError with correct context for non-retryable errors", async () => {
      const originalError = { name: "NoSuchKey" };
      const operation = jest.fn().mockRejectedValue(originalError);

      try {
        await retryWithBackoff(operation, defaultConfig, "head-object");
        fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(RetryError);
        const retryError = error as RetryError;
        expect(retryError.message).toContain("head-object");
        expect(retryError.message).toContain("non-retryable");
        expect(retryError.cause).toBe(originalError);
        expect(retryError.attempts).toBe(1);
        expect(retryError.maxAttempts).toBe(3);
      }
    });

    it("throws RetryError after exhausting all attempts", async () => {
      const originalError = { name: "ThrottlingException" };
      const operation = jest.fn().mockRejectedValue(originalError);

      const promise = retryWithBackoff(operation, defaultConfig, "restore-object");

      // Attach a catch handler immediately to prevent unhandled rejection
      const resultPromise = promise.then(
        () => { throw new Error("Should have thrown"); },
        (error) => error
      );

      // Advance through all retry delays: 1000ms + 2000ms
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);

      const error = await resultPromise;
      expect(error).toBeInstanceOf(RetryError);
      expect(error.message).toContain("restore-object");
      expect(error.message).toContain("3 attempts");
      expect(error.cause).toBe(originalError);
      expect(error.attempts).toBe(3);
      expect(error.maxAttempts).toBe(3);
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it("applies exponential backoff between retries", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ name: "ThrottlingException" })
        .mockRejectedValueOnce({ name: "ThrottlingException" })
        .mockResolvedValue("success");

      const promise = retryWithBackoff(operation, defaultConfig, "test-op");

      // After first failure, should wait 1000ms (baseDelay * 2^0)
      expect(operation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(999);
      expect(operation).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(operation).toHaveBeenCalledTimes(2);

      // After second failure, should wait 2000ms (baseDelay * 2^1)
      await jest.advanceTimersByTimeAsync(1999);
      expect(operation).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(operation).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toBe("success");
    });

    it("retries on HTTP 500 status code errors", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({
          name: "UnknownError",
          $metadata: { httpStatusCode: 500 },
        })
        .mockResolvedValue("success");

      const promise = retryWithBackoff(operation, defaultConfig, "test-op");
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("works with RESTORE_OBJECT_RETRY config (5 attempts)", async () => {
      const restoreConfig: RetryConfig = {
        maxAttempts: 5,
        baseDelayMs: 1000,
        multiplier: 2,
        maxDelayMs: 16000,
      };

      const operation = jest
        .fn()
        .mockRejectedValueOnce({ name: "SlowDown" })
        .mockRejectedValueOnce({ name: "SlowDown" })
        .mockRejectedValueOnce({ name: "SlowDown" })
        .mockRejectedValueOnce({ name: "SlowDown" })
        .mockResolvedValue("restored");

      const promise = retryWithBackoff(operation, restoreConfig, "restore");

      // Advance through delays: 1000 + 2000 + 4000 + 8000
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(4000);
      await jest.advanceTimersByTimeAsync(8000);

      const result = await promise;
      expect(result).toBe("restored");
      expect(operation).toHaveBeenCalledTimes(5);
    });
  });
});
