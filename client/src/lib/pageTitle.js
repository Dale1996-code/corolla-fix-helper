// The one place the product name is spelled for the browser tab.
//
// Before this module there was no per-page title at all: `client/index.html`
// hard-coded a single static <title> that stayed "Corolla Fix Helper" on all
// nine routes, so a bookmark or a second tab said nothing about which page it
// pointed at. Anything that needs to *print* the product name in the UI should
// import PRODUCT_NAME rather than re-typing it -- a second literal is how
// "Local Repair Helper" got into the sidebar in the first place.
export const PRODUCT_NAME = "Corolla Fix Helper";

/**
 * The browser tab title for a page: `<page> | Corolla Fix Helper`.
 *
 * A page with no usable label falls back to the bare product name rather than
 * a dangling separator.
 *
 * @param {unknown} pageLabel
 * @returns {string}
 */
export function formatPageTitle(pageLabel) {
  const label = typeof pageLabel === "string" ? pageLabel.trim() : "";

  return label && label !== PRODUCT_NAME ? `${label} | ${PRODUCT_NAME}` : PRODUCT_NAME;
}
