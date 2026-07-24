import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeText, hasOwnField } from "../src/utils/text.js";
import {
  parsePositiveInt,
  parsePositiveIntArray,
  isLoopbackAddress,
  isLoopbackRequest,
} from "../src/utils/http.js";

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

test("parsePositiveIntArray returns an empty list for non-array input", () => {
  assert.deepEqual(parsePositiveIntArray(undefined), []);
  assert.deepEqual(parsePositiveIntArray(null), []);
  assert.deepEqual(parsePositiveIntArray("1,2,3"), []);
  assert.deepEqual(parsePositiveIntArray(5), []);
  assert.deepEqual(parsePositiveIntArray({ 0: 1 }), []);
  assert.deepEqual(parsePositiveIntArray([]), []);
});

test("parsePositiveIntArray keeps positive integers and coerces numeric strings", () => {
  assert.deepEqual(parsePositiveIntArray([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(parsePositiveIntArray(["4", "5"]), [4, 5]);
});

test("parsePositiveIntArray drops zero, negative, fractional, and non-numeric items", () => {
  assert.deepEqual(parsePositiveIntArray([0, -1, 2.5, "abc", null, undefined, "3"]), [3]);
});

test("parsePositiveIntArray removes duplicates while preserving first-seen order", () => {
  assert.deepEqual(parsePositiveIntArray([3, 1, 3, 2, "1"]), [3, 1, 2]);
});

test("isLoopbackAddress recognizes IPv4/IPv6 loopback and rejects LAN addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.5.6.7"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);

  assert.equal(isLoopbackAddress("192.168.1.20"), false);
  assert.equal(isLoopbackAddress("10.0.0.4"), false);
  assert.equal(isLoopbackAddress("100.101.102.103"), false); // Tailscale CGNAT range
  assert.equal(isLoopbackAddress("::ffff:192.168.1.20"), false);
  assert.equal(isLoopbackAddress(""), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("isLoopbackRequest reads the raw socket peer address", () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isLoopbackRequest({ connection: { remoteAddress: "::1" } }), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "192.168.1.9" } }), false);
  assert.equal(isLoopbackRequest({}), false);
});
