import {
  validateBucket,
  validateFilePath,
  validateRetrievalTier,
  validateRestoreDays,
  validateAndDeduplicateFilePaths,
  validateRestoreRequest,
  validateBatchRestoreRequest,
} from "../../src/shared/validation";

describe("validateBucket", () => {
  it("accepts a valid bucket name", () => {
    expect(validateBucket("my-bucket")).toEqual([]);
  });

  it("accepts bucket at minimum length (3 chars)", () => {
    expect(validateBucket("abc")).toEqual([]);
  });

  it("accepts bucket at maximum length (63 chars)", () => {
    expect(validateBucket("a".repeat(63))).toEqual([]);
  });

  it("rejects empty string", () => {
    const errors = validateBucket("");
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("bucket");
  });

  it("rejects bucket shorter than 3 chars", () => {
    const errors = validateBucket("ab");
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("bucket");
    expect(errors[0].message).toContain("3");
  });

  it("rejects bucket longer than 63 chars", () => {
    const errors = validateBucket("a".repeat(64));
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("bucket");
  });

  it("rejects non-string values", () => {
    expect(validateBucket(undefined)).toHaveLength(1);
    expect(validateBucket(null)).toHaveLength(1);
    expect(validateBucket(123)).toHaveLength(1);
  });
});

describe("validateFilePath", () => {
  it("accepts a valid file path", () => {
    expect(validateFilePath("path/to/file.txt")).toEqual([]);
  });

  it("accepts path at minimum length (1 char)", () => {
    expect(validateFilePath("a")).toEqual([]);
  });

  it("accepts path at maximum length (1024 chars)", () => {
    expect(validateFilePath("a".repeat(1024))).toEqual([]);
  });

  it("rejects empty string", () => {
    const errors = validateFilePath("");
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("filePath");
  });

  it("rejects path longer than 1024 chars", () => {
    const errors = validateFilePath("a".repeat(1025));
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("filePath");
  });

  it("includes index in field name when provided", () => {
    const errors = validateFilePath("", 2);
    expect(errors[0].field).toBe("filePaths[2]");
  });

  it("rejects non-string values", () => {
    expect(validateFilePath(undefined)).toHaveLength(1);
    expect(validateFilePath(null)).toHaveLength(1);
  });
});

describe("validateRetrievalTier", () => {
  it("accepts Expedited", () => {
    expect(validateRetrievalTier("Expedited")).toEqual([]);
  });

  it("accepts Standard", () => {
    expect(validateRetrievalTier("Standard")).toEqual([]);
  });

  it("accepts Bulk", () => {
    expect(validateRetrievalTier("Bulk")).toEqual([]);
  });

  it("rejects invalid tier", () => {
    const errors = validateRetrievalTier("Fast");
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("retrievalTier");
    expect(errors[0].message).toContain("Expedited");
  });

  it("rejects empty string", () => {
    expect(validateRetrievalTier("")).toHaveLength(1);
  });

  it("rejects non-string values", () => {
    expect(validateRetrievalTier(undefined)).toHaveLength(1);
    expect(validateRetrievalTier(null)).toHaveLength(1);
  });

  it("is case-sensitive", () => {
    expect(validateRetrievalTier("expedited")).toHaveLength(1);
    expect(validateRetrievalTier("STANDARD")).toHaveLength(1);
  });
});

describe("validateRestoreDays", () => {
  it("accepts valid integer within range", () => {
    const result = validateRestoreDays(7);
    expect(result.errors).toEqual([]);
    expect(result.value).toBe(7);
  });

  it("accepts minimum value (1)", () => {
    const result = validateRestoreDays(1);
    expect(result.errors).toEqual([]);
    expect(result.value).toBe(1);
  });

  it("accepts maximum value (30)", () => {
    const result = validateRestoreDays(30);
    expect(result.errors).toEqual([]);
    expect(result.value).toBe(30);
  });

  it("defaults to 7 when undefined", () => {
    const result = validateRestoreDays(undefined);
    expect(result.errors).toEqual([]);
    expect(result.value).toBe(7);
  });

  it("defaults to 7 when null", () => {
    const result = validateRestoreDays(null);
    expect(result.errors).toEqual([]);
    expect(result.value).toBe(7);
  });

  it("rejects value below minimum (0)", () => {
    const result = validateRestoreDays(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe("restoreDays");
  });

  it("accepts values above 30 (no upper bound)", () => {
    const result = validateRestoreDays(31);
    expect(result.errors).toEqual([]);
    expect(result.value).toBe(31);
  });

  it("rejects non-integer values", () => {
    const result = validateRestoreDays(3.5);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe("restoreDays");
  });

  it("accepts string that parses to valid integer", () => {
    const result = validateRestoreDays("14");
    expect(result.errors).toEqual([]);
    expect(result.value).toBe(14);
  });

  it("rejects non-numeric string", () => {
    const result = validateRestoreDays("abc");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe("restoreDays");
  });

  it("rejects negative values", () => {
    const result = validateRestoreDays(-5);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe("restoreDays");
  });
});

describe("validateAndDeduplicateFilePaths", () => {
  it("deduplicates paths and returns unique set", () => {
    const result = validateAndDeduplicateFilePaths(
      ["file1.txt", "file2.txt", "file1.txt"],
      1
    );
    expect(result.errors).toEqual([]);
    expect(result.deduplicatedPaths).toEqual(["file1.txt", "file2.txt"]);
  });

  it("rejects non-array input", () => {
    const result = validateAndDeduplicateFilePaths("not-an-array", 1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe("filePaths");
  });

  it("rejects empty array", () => {
    const result = validateAndDeduplicateFilePaths([], 1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe("filePaths");
  });

  it("rejects when unique count is below minimum", () => {
    const result = validateAndDeduplicateFilePaths(["file1.txt", "file1.txt"], 2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("at least 2");
  });

  it("rejects when unique count exceeds 1000", () => {
    const paths = Array.from({ length: 1001 }, (_, i) => `file${i}.txt`);
    const result = validateAndDeduplicateFilePaths(paths, 1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("1000");
  });

  it("validates individual path lengths", () => {
    const result = validateAndDeduplicateFilePaths(["a".repeat(1025)], 1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe("filePaths[0]");
  });

  it("accepts exactly 1000 unique paths", () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `file${i}.txt`);
    const result = validateAndDeduplicateFilePaths(paths, 1);
    expect(result.errors).toEqual([]);
    expect(result.deduplicatedPaths).toHaveLength(1000);
  });
});

describe("validateRestoreRequest", () => {
  it("accepts a valid single-file request", () => {
    const result = validateRestoreRequest({
      bucket: "my-bucket",
      filePaths: ["path/to/file.txt"],
      retrievalTier: "Standard",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.deduplicatedPaths).toEqual(["path/to/file.txt"]);
    expect(result.restoreDays).toBe(7);
  });

  it("accepts a valid request with custom restoreDays", () => {
    const result = validateRestoreRequest({
      bucket: "my-bucket",
      filePaths: ["file1.txt"],
      retrievalTier: "Standard",
      restoreDays: 14,
    });
    expect(result.valid).toBe(true);
    expect(result.restoreDays).toBe(14);
  });

  it("accepts a valid multi-file request", () => {
    const result = validateRestoreRequest({
      bucket: "my-bucket",
      filePaths: ["file1.txt", "file2.txt"],
      retrievalTier: "Bulk",
    });
    expect(result.valid).toBe(true);
    expect(result.deduplicatedPaths).toEqual(["file1.txt", "file2.txt"]);
    expect(result.restoreDays).toBe(7);
  });

  it("returns error when restoreDays is invalid", () => {
    const result = validateRestoreRequest({
      bucket: "my-bucket",
      filePaths: ["file1.txt"],
      retrievalTier: "Standard",
      restoreDays: 0,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "restoreDays")).toBe(true);
  });

  it("returns multiple field errors when multiple fields are invalid", () => {
    const result = validateRestoreRequest({
      bucket: "",
      filePaths: [],
      retrievalTier: "Invalid",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    const fields = result.errors.map((e) => e.field);
    expect(fields).toContain("bucket");
    expect(fields).toContain("retrievalTier");
  });

  it("deduplicates paths in the result", () => {
    const result = validateRestoreRequest({
      bucket: "my-bucket",
      filePaths: ["a.txt", "b.txt", "a.txt"],
      retrievalTier: "Standard",
    });
    expect(result.valid).toBe(true);
    expect(result.deduplicatedPaths).toEqual(["a.txt", "b.txt"]);
  });
});

describe("validateBatchRestoreRequest", () => {
  it("accepts a valid batch request with 2+ unique paths", () => {
    const result = validateBatchRestoreRequest({
      bucket: "my-bucket",
      filePaths: ["file1.txt", "file2.txt"],
      retrievalTier: "Standard",
    });
    expect(result.valid).toBe(true);
    expect(result.deduplicatedPaths).toEqual(["file1.txt", "file2.txt"]);
  });

  it("rejects batch request with only 1 unique path", () => {
    const result = validateBatchRestoreRequest({
      bucket: "my-bucket",
      filePaths: ["file1.txt"],
      retrievalTier: "Standard",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("at least 2");
  });

  it("rejects batch request where duplicates reduce count below 2", () => {
    const result = validateBatchRestoreRequest({
      bucket: "my-bucket",
      filePaths: ["file1.txt", "file1.txt", "file1.txt"],
      retrievalTier: "Standard",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("at least 2");
  });

  it("accepts batch request at maximum (1000 unique paths)", () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `file${i}.txt`);
    const result = validateBatchRestoreRequest({
      bucket: "my-bucket",
      filePaths: paths,
      retrievalTier: "Bulk",
    });
    expect(result.valid).toBe(true);
    expect(result.deduplicatedPaths).toHaveLength(1000);
  });
});
