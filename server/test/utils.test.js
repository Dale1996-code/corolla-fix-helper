import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeText, hasOwnField } from "../src/utils/text.js";
import { parsePositiveInt } from "../src/utils/http.js";

test("normalizeText trims strings and returns empty string for non-strings", () => {
  assert.equal(normalizeText("  hello  "), "hello");
  assert.equal(normalizeText(""), "");
  assert.equal(normalizeText("   "), "");
  assert.equal(normalizeText(undefined), "");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(42), "");
});

test("normalizeText uses the fallback only when the trimmed value is blank", () => {
  assert.equal(normalizeText("  ", "default"), "default");
  assert.equal(normalizeText(undefined, "default"), "default");
  assert.equal(normalizeText("value", "default"), "value");
});

test("hasOwnField ignores inherited properties", () => {
  assert.equal(hasOwnField({ title: "" }, "title"), true);
  assert.equal(hasOwnField({}, "title"), false);
  assert.equal(hasOwnField({}, "hasOwnProperty"), false);
});

test("parsePositiveInt accepts positive integers and rejects everything else", () => {
  assert.equal(parsePositiveInt("5"), 5);
  assert.equal(parsePositiveInt(5), 5);
  assert.equal(parsePositiveInt("0"), null);
  assert.equal(parsePositiveInt("-3"), null);
  assert.equal(parsePositiveInt("2.5"), null);
  assert.equal(parsePositiveInt("abc"), null);
  assert.equal(parsePositiveInt(""), null);
  assert.equal(parsePositiveInt(undefined), null);
});
