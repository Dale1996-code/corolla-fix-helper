import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:mock";
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => {};
}
// jsdom does not implement scrollIntoView, and useScrollToHash calls it on any
// page rendered at a URL whose #hash matches an element -- which is exactly the
// shape of the deep links buildEntityLink() produces. Without this, testing
// those links throws instead of exercising them.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
});
