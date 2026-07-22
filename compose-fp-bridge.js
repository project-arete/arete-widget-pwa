// compose-fp-bridge.js — runs INSIDE the Compose preview iframe, BEFORE
// faceplate.js (the Composer injects this script tag when it builds the
// iframe's srcdoc). It fetches the mock `window.faceplate` API from the
// parent document (same origin: srcdoc inherits the renderer's origin), so
// faceplate.js runs UNMODIFIED against mock state — the canvas preview is
// the real renderer, not a copy of it.
//
// Same pattern as the Widget PWA's faceplate-bridge.js (overlay iframes).
(function () {
  try {
    if (window.parent && typeof window.parent.__composeBridge === 'function') {
      window.faceplate = window.parent.__composeBridge();
    }
  } catch (_) {
    /* cross-origin or no parent — leave window.faceplate undefined and
       faceplate.js will show its "no longer exists" notice */
  }
})();
