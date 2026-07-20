// faceplate-bridge.js — runs INSIDE the faceplate iframe, before faceplate.js.
// The parent page (browser-widget-bridge.js) provides the same window.faceplate
// API the Electron preload used to expose; same-origin makes this a direct call.
(() => {
  const id = new URLSearchParams(location.search).get('instance') || '';
  window.faceplate = window.parent.__fpBridge(id, window);
  // faceplate.js closes with window.close() — route it to the overlay manager
  window.close = () => window.parent.__fpClose(id);
})();
