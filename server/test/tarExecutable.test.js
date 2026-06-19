import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveTarExecutable } from "../src/services/tarExecutable.js";

test("resolveTarExecutable uses SystemRoot native tar on Windows", () => {
  const expected = path.win32.join("D:\\Windows", "System32", "tar.exe");
  const checkedPaths = [];

  const result = resolveTarExecutable({
    platform: "win32",
    env: { SystemRoot: "D:\\Windows" },
    fs: {
      existsSync(filePath) {
        checkedPaths.push(filePath);
        return filePath === expected;
      },
    },
  });

  assert.equal(result, expected);
  assert.deepEqual(checkedPaths, [expected]);
});

test("resolveTarExecutable uses tar on non-Windows platforms", () => {
  const result = resolveTarExecutable({
    platform: "linux",
    env: {},
    fs: {
      existsSync() {
        throw new Error("non-Windows resolution must not inspect the filesystem");
      },
    },
  });

  assert.equal(result, "tar");
});

test("resolveTarExecutable uses an existing Windows fallback when SystemRoot is missing", () => {
  const expected = path.win32.join("E:\\", "Windows", "System32", "tar.exe");

  const result = resolveTarExecutable({
    platform: "win32",
    env: { SystemDrive: "E:" },
    fs: { existsSync: (filePath) => filePath === expected },
  });

  assert.equal(result, expected);
});

test("resolveTarExecutable reports a clear error when Windows native tar is missing", () => {
  assert.throws(
    () =>
      resolveTarExecutable({
        platform: "win32",
        env: {},
        fs: { existsSync: () => false },
      }),
    /Native Windows tar\.exe was not found/
  );
});
