import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const configProbe = `
  import { config } from "./src/config.js";
  console.log(JSON.stringify({
    answer: config.openAiAnswerModel,
    vision: config.openAiVisionModel,
    rerank: config.openAiRerankModel
  }));
`;

function loadModelConfig(overrides) {
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", configProbe], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        // Blank values prevent dotenv from picking up a developer's local
        // server/.env, while still exercising the config module's fallbacks.
        OPENAI_ANSWER_MODEL: "",
        OPENAI_MODEL: "",
        ...overrides,
      },
    })
  );
}

test("uses the pinned GPT-5.5 snapshot when no answer-model override is set", () => {
  assert.deepEqual(loadModelConfig({}), {
    answer: "gpt-5.5-2026-04-23",
    vision: "gpt-5.5-2026-04-23",
    rerank: "gpt-5.5-2026-04-23",
  });
});

test("keeps the current and legacy answer-model environment overrides", () => {
  assert.equal(loadModelConfig({ OPENAI_ANSWER_MODEL: "current-model" }).answer, "current-model");
  assert.equal(loadModelConfig({ OPENAI_MODEL: "legacy-model" }).answer, "legacy-model");
});
