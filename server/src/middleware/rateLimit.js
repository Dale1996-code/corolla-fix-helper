// A tiny in-memory, fixed-window rate limiter.
//
// The repo deliberately avoids extra dependencies, so this stands in for a
// package like express-rate-limit. It is enough for a single-user, local-first
// app: it caps how often the AI endpoints can be hit (protecting the OpenAI
// budget if the app is ever exposed) and returns a generic 429 — never a stack
// trace. `now` is injectable so the window logic is testable without real time.

export function createRateLimiter({
  windowMs = 60_000,
  max = 20,
  now = () => Date.now(),
  message = "Too many requests. Please wait a moment and try again.",
} = {}) {
  // key -> { count, resetAt }
  const hits = new Map();

  return function rateLimit(request, response, next) {
    const key = request.ip || request.socket?.remoteAddress || "unknown";
    const currentTime = now();
    const entry = hits.get(key);

    if (!entry || currentTime >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: currentTime + windowMs });
      next();
      return;
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000));
      response.setHeader("Retry-After", String(retryAfterSeconds));
      response.status(429).json({ error: message });
      return;
    }

    next();
  };
}
