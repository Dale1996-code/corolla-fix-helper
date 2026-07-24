import assert from "node:assert/strict";
import test from "node:test";

// Each test file runs in its own process, so setting NETWORK_MODE before the
// config module is imported deterministically exercises the opt-in path.
process.env.NETWORK_MODE = "1";

const { config } = await import("../src/config.js");

test("NETWORK_MODE=1 opts into binding on all interfaces", () => {
  assert.equal(config.networkMode, true);
  assert.equal(config.host, "0.0.0.0");
});
