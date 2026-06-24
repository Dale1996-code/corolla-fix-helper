import assert from "node:assert/strict";
import test from "node:test";

import { createRateLimiter } from "../src/middleware/rateLimit.js";

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("rate limiter allows requests up to the max, then returns a generic 429", () => {
  let clock = 1000;
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, now: () => clock });
  const req = { ip: "1.2.3.4" };

  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
  };

  limiter(req, mockResponse(), next);
  limiter(req, mockResponse(), next);
  const third = mockResponse();
  limiter(req, third, next);

  assert.equal(nextCalls, 2, "the first two requests pass through");
  assert.equal(third.statusCode, 429);
  assert.ok(third.body.error, "a 429 returns an error message");
  assert.ok(
    !/\bat \/|Error:|\.js:\d/.test(third.body.error),
    "the message is generic, not a stack trace"
  );
});

test("rate limiter resets after the window elapses", () => {
  let clock = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => clock });
  const req = { ip: "5.6.7.8" };

  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
  };

  limiter(req, mockResponse(), next); // allowed
  const blocked = mockResponse();
  limiter(req, blocked, next); // blocked
  assert.equal(blocked.statusCode, 429);

  clock = 1500; // window has elapsed
  limiter(req, mockResponse(), next); // allowed again
  assert.equal(nextCalls, 2);
});

test("rate limiter tracks clients separately by ip", () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });

  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
  };

  limiter({ ip: "a" }, mockResponse(), next);
  limiter({ ip: "b" }, mockResponse(), next);

  assert.equal(nextCalls, 2, "different ips each get their own allowance");
});
