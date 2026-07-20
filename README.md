# Arete Widget — PWA

**[Open the app → project-arete.github.io/arete-widget-pwa](https://project-arete.github.io/arete-widget-pwa/)**

[Arete Widget](https://github.com/project-arete/arete-widget) as an installable
web app: describe a device as a **YAML widget** — its CP capabilities plus a
faceplate — and it registers as a governed node on your CNS/CP realm with a
live control panel. No hardware, and now no install: faceplates open as
full-screen panels on a phone, overlay windows on the desktop.

## Install on a phone

- **iPhone / iPad** — open the app URL in Safari → Share → **Add to Home Screen**.
- **Android** — open it in Chrome → **Install app**.

## Browser notes

- The realm must present a **valid TLS certificate** (all `*.aretehosting.com`
  realms qualify); realms requiring Basic auth are not reachable from browsers yet.
- **Widgets live while the app is open.** On a phone the page is suspended in
  the background, so treat this as a remote control and demo tool — the desktop
  app remains the right host for always-on virtual devices.
- Definitions come from the bundled set plus the online
  [widget library](https://project-arete.github.io/widget-library/) (library
  overrides bundled, exactly like the desktop app).

## Relationship to the desktop app

The renderer (tile grid, dialogs, faceplates) and the portable core
(`widget-spec`, `behavior-engine`) are byte-identical copies from
[arete-widget](https://github.com/project-arete/arete-widget). The Electron
layer is replaced by `browser-widget-bridge.js` (browser-native Arete client +
localStorage-backed widget manager + faceplate overlays) and
`faceplate-bridge.js` (the in-iframe stand-in for the faceplate preload).
Desktop semantics preserved: value-preserving attach (no capability
re-declaration), per-connection control, aggregate rules, identity sync.
When the desktop renderer evolves, copy the files over and bump `sw.js`'s VERSION.
