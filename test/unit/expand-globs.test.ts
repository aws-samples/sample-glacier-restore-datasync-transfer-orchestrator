import {
  isGlobPattern,
  globToRegex,
  extractPrefix,
} from "../../src/orchestrator/steps/expand-globs";

describe("expand-globs", () => {
  describe("isGlobPattern", () => {
    it("returns true for paths containing *", () => {
      expect(isGlobPattern("project/renders/*.exr")).toBe(true);
    });

    it("returns true for paths with * in the middle", () => {
      expect(isGlobPattern("project/*/file.dat")).toBe(true);
    });

    it("returns false for literal paths", () => {
      expect(isGlobPattern("project/renders/frame_001.exr")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isGlobPattern("")).toBe(false);
    });
  });

  describe("globToRegex", () => {
    it("matches wildcard in filename", () => {
      const regex = globToRegex("project/renders/*.exr");
      expect(regex.test("project/renders/frame_001.exr")).toBe(true);
      expect(regex.test("project/renders/frame_002.exr")).toBe(true);
      expect(regex.test("project/renders/anything.exr")).toBe(true);
    });

    it("does not match across directory boundaries", () => {
      const regex = globToRegex("project/renders/*.exr");
      expect(regex.test("project/renders/subdir/frame.exr")).toBe(false);
    });

    it("does not match different extensions", () => {
      const regex = globToRegex("project/renders/*.exr");
      expect(regex.test("project/renders/frame_001.tif")).toBe(false);
    });

    it("matches wildcard prefix", () => {
      const regex = globToRegex("project/*/file.dat");
      expect(regex.test("project/alpha/file.dat")).toBe(true);
      expect(regex.test("project/beta/file.dat")).toBe(true);
      expect(regex.test("project/alpha/beta/file.dat")).toBe(false);
    });

    it("matches multiple wildcards", () => {
      const regex = globToRegex("project/*/renders/*.exr");
      expect(regex.test("project/alpha/renders/frame.exr")).toBe(true);
      expect(regex.test("project/beta/renders/other.exr")).toBe(true);
      expect(regex.test("project/alpha/renders/sub/frame.exr")).toBe(false);
    });

    it("escapes regex special characters", () => {
      const regex = globToRegex("data/file[1].dat");
      expect(regex.test("data/file[1].dat")).toBe(true);
      expect(regex.test("data/file1.dat")).toBe(false);
    });

    it("handles pattern with no wildcard (exact match)", () => {
      const regex = globToRegex("exact/path/file.txt");
      expect(regex.test("exact/path/file.txt")).toBe(true);
      expect(regex.test("exact/path/other.txt")).toBe(false);
    });
  });

  describe("extractPrefix", () => {
    it("extracts prefix up to last / before first *", () => {
      expect(extractPrefix("project/renders/*.exr")).toBe("project/renders/");
    });

    it("extracts prefix for wildcard in directory name", () => {
      expect(extractPrefix("project/*/file.dat")).toBe("project/");
    });

    it("returns empty string when * is at the start", () => {
      expect(extractPrefix("*.exr")).toBe("");
    });

    it("returns full path when no wildcard present", () => {
      expect(extractPrefix("project/renders/frame.exr")).toBe("project/renders/frame.exr");
    });

    it("handles wildcard immediately after prefix", () => {
      expect(extractPrefix("data/*")).toBe("data/");
    });
  });
});
