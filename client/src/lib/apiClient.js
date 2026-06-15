// Thin wrapper around fetch for JSON endpoints.
//
// Collapses the boilerplate that was repeated across pages:
//   const response = await fetch(url, options);
//   const payload = await response.json();
//   if (!response.ok) throw new Error(payload.error || "...");
//
// Use this only for endpoints that always return a JSON body (success and
// error alike). Endpoints that return a non-JSON success payload (e.g. file
// downloads) should keep calling fetch directly.

/**
 * Fetch a URL expecting a JSON response, returning the parsed body.
 *
 * Pass `errorMessage` for the fallback thrown when the response is not ok and
 * the server did not include an `error` field. Any other option is forwarded
 * to `fetch` unchanged (method, headers, body, ...).
 *
 * @param {string} url
 * @param {RequestInit & { errorMessage?: string }} [options]
 */
export async function requestJson(url, options = {}) {
  const { errorMessage = "Request failed.", ...fetchOptions } = options;

  const response = await fetch(url, fetchOptions);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error((payload && payload.error) || errorMessage);
  }

  return payload;
}
