import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/pages/stack.md", import.meta.url), "utf8");

test("stack design distinguishes proposed tests from implemented guarantees", () => {
  expect(source).toContain("not an implemented operating system");
  expect(source).toContain("proposed acceptance gates, not passing test results");
  expect(source).toContain("uncertain");
  expect(source).toContain("fencing token");
  expect(source).toContain("does not promise exactly-once");
});

test("stack cites primary execution, security, and recovery sources", () => {
  expect(source).toContain("https://docs.wasmtime.dev/security.html");
  expect(source).toContain("https://docs.temporal.io/activity-execution");
  expect(source).toContain("https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md");
});
