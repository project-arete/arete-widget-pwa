// compose-bridge.js — the PWA's browser implementation of the Composer's
// main-process API (compose:check / simulate / profileIndex from the desktop
// app's electron/main.js), as a PORTABLE module: no window, no localStorage —
// browser-widget-bridge.js wires storage and the manager around it, and a
// plain Node run (scripts/test-compose-bridge.mjs) can drive it against the
// live registry. Keep semantics 1:1 with the desktop handlers.

import { validateDefinition, orderDefinition, parseProfile } from './core/widget-spec.js';
import { computeActions } from './core/behavior-engine.js';
import yaml from './js-yaml.mjs';

/** Canonical YAML for a definition object (the Composer's single format). */
export const dumpDefinition = (raw) => yaml.dump(orderDefinition(raw), { lineWidth: 120, noRefs: true });

/**
 * Validate a draft (definition object or YAML text) exactly like the desktop
 * compose:check — returns { ok, errors, model, raw, yaml, caps }.
 * @param {object|string} draft
 * @param {(name:string)=>Promise<object|null>} fetchProfile registry fetch (cached by caller)
 */
export async function composeCheck(draft, fetchProfile) {
  let raw = draft;
  if (typeof draft === 'string') {
    try {
      raw = yaml.load(draft);
    } catch (err) {
      return { ok: false, errors: ['YAML parse error: ' + (err.message || err)], model: null, raw: null, yaml: '', caps: [] };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Definition is not a mapping.'], model: null, raw: null, yaml: '', caps: [] };
  }
  const profiles = {};
  const capsIn = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  for (const c of capsIn) {
    const name = c && typeof c.profile === 'string' ? c.profile.trim() : '';
    if (name && !(name in profiles)) profiles[name] = await fetchProfile(name);
  }
  const res = validateDefinition(raw, profiles);
  const caps = capsIn.map((c) => {
    const profile = c && typeof c.profile === 'string' ? c.profile.trim() : '';
    const role = c && typeof c.role === 'string' ? c.role.trim() : '';
    const parsed = parseProfile(profiles[profile]);
    return { profile, role, ok: !!parsed, title: parsed ? parsed.title : '', props: parsed ? parsed.props : {} };
  });
  let text = '';
  try {
    text = dumpDefinition(raw);
  } catch (_) {}
  return { ok: res.ok, errors: res.errors, model: res.model, raw, yaml: text, caps };
}

/**
 * Draft-preview rule simulation over mock state (no realm, no connections).
 * Bounded iteration — a (mis)configured rule pair can never loop forever.
 */
export function composeSimulate(model, state) {
  if (!model || !model.behavior) return { state: state || {}, fired: [] };
  const s = { ...(state || {}) };
  const fired = [];
  for (let i = 0; i < 8; i++) {
    const actions = computeActions(model, s, {}, {});
    if (!actions.length) break;
    for (const a of actions) {
      s[a.property] = String(a.value);
      fired.push({ property: a.property, value: String(a.value) });
    }
  }
  return { state: s, fired };
}

/** Slim a raw GET /profiles index for the picker (same shape as desktop main). */
export function slimProfileIndex(list) {
  return (list || []).map((p) => {
    const parsed = parseProfile(p);
    return {
      name: p.name,
      title: p.title || '',
      comment: p.comment || '',
      company: p.company || '',
      modified: p.modified || '',
      props: parsed ? parsed.props : null,
    };
  }).filter((p) => p.name);
}
