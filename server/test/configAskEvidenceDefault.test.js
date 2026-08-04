import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const configProbe = `
  import { config } from "./src/config.js";
  console.log(JSON.stringify({ askEvidenceContract: config.askEvidenceContract }));
`;

function loadAskEvidenceConfig(value) {
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", configProbe], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        // Blank prevents a developer's local .env from changing this test while
        // still exercising the fallback used when the setting is omitted.
        ASK_EVIDENCE_CONTRACT: value,
      },
    })
  );
}

test("Ask evidence verification is enabled by default", () => {
  assert.deepEqual(loadAskEvidenceConfig(""), { askEvidenceContract: true });
});

test("an explicit false value keeps the legacy compatibility path available", () => {
  assert.deepEqual(loadAskEvidenceConfig("false"), { askEvidenceContract: false });
});
