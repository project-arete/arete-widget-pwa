// core/behavior-engine.js
// ---------------------------------------------------------------------------
// PORTABLE (no Electron, no Node APIs). The auto-actualize engine.
//
// Design: rather than reacting to individual watch events (the SDK's .watch has
// a null-match crash bug, and events can be missed across reconnects), the
// engine is a CONVERGENCE function over derived state. After every keys update:
//     actions = computeActions(model, state, pending)
// puts the returned {property, value} list, and the widget converges on its
// declared behavior no matter what happened while it was offline. Idempotent:
// once state reflects the rule outcome, no further actions are produced.
//
// `pending` guards the put-echo window: a put we issued but whose echo hasn't
// come back yet must not be re-issued on every intermediate update. The caller
// owns the pending map (property -> value) and clears entries when state
// confirms them (also done here in reconcilePending).
// ---------------------------------------------------------------------------

/**
 * Derive the faceplate/rule state for one instance from the flat CNS keys.
 *
 * Returns BOTH views of the truth:
 *  - `state`: capability properties overlaid by connection properties — the
 *    merged view. With 0-1 connections this is exact; with 2+ connections,
 *    peer-written properties are last-write-wins and therefore ambiguous —
 *    consumers of this API should use `perConn` to detect/display conflicts.
 *  - `perConn`: connId -> properties of THAT connection (connections mirror
 *    both sides' props, so each entry is a complete per-peer view).
 *
 * @param {Object<string,string>} keys flat CNS namespace
 * @param {object} inst {systemId, nodeId, contextId}
 * @param {object} model validated widget model (capabilities: [{profile, role}])
 * @returns {{state:Object<string,string>, connections:number, perConn:Object<string,Object<string,string>>}}
 */
export function deriveState(keys, inst, model) {
  const capProps = {};
  const perConn = {};
  const allConnIds = [];
  for (const cap of model.capabilities) {
    const prefix = `cns/${inst.systemId}/nodes/${inst.nodeId}/contexts/${inst.contextId}/${cap.role}/${cap.profile}/`;
    const connIds = new Set();
    for (const k in keys) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest.startsWith('properties/')) {
        capProps[rest.slice('properties/'.length)] = keys[k];
      } else if (rest.startsWith('connections/')) {
        const connId = rest.split('/')[1];
        connIds.add(connId);
        const m = rest.match(/^connections\/[^/]+\/properties\/(.+)$/);
        if (m) (perConn[connId] || (perConn[connId] = {}))[m[1]] = keys[k];
      }
    }
    allConnIds.push(...connIds);
  }
  // Merged view: capability props first, then connection overlays.
  const state = { ...capProps };
  for (const id of allConnIds) if (perConn[id]) Object.assign(state, perConn[id]);
  return { state, connections: allConnIds.length, perConn };
}

// Aggregate a rule's input across ALL connections (perConn). Numeric only:
// any non-numeric value, or no connection carrying the property, falls back
// to the merged view (i.e. plain rule behavior). Rounded to 3 decimals so
// float noise never leaks onto the realm ("0.5", not "0.5000000001").
function aggregateInput(rule, state, perConn) {
  const vals = [];
  for (const id in perConn) {
    const v = perConn[id][rule.when];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) return state[rule.when]; // non-numeric — merged view
    vals.push(n);
  }
  if (!vals.length) return state[rule.when]; // no connection carries it yet
  let out;
  switch (rule.aggregate) {
    case 'average': out = vals.reduce((a, b) => a + b, 0) / vals.length; break;
    case 'min': out = Math.min(...vals); break;
    case 'max': out = Math.max(...vals); break;
    default: return state[rule.when];
  }
  return String(Math.round(out * 1000) / 1000);
}

/**
 * Compute the puts needed to converge on the widget's behavior rules.
 * @param {object} model validated widget model ({behavior:{rules}})
 * @param {Object<string,string>} state derived state
 * @param {Object<string,string>} pending puts already in flight (prop -> value)
 * @param {Object<string,Object<string,string>>} [perConn] connId -> that
 *   connection's properties — required for rules with `aggregate:` (a rule
 *   like "cState = average(sOut) across connections"; e.g. one of two
 *   controllers on -> "0.5"). Plain rules ignore it.
 * @returns {Array<{property:string, value:string}>}
 */
export function computeActions(model, state, pending = {}, perConn = {}) {
  const actions = [];
  for (const rule of model.behavior.rules) {
    if (rule.reply) {
      // Addressed rule: react per connection, respond on the SAME connection.
      for (const connId in perConn) {
        const raw = perConn[connId][rule.when];
        if (raw === undefined || raw === null) continue;
        const out = rule.map ? (rule.map[String(raw)] ?? String(raw)) : String(raw);
        if (perConn[connId][rule.set] === out) continue;          // converged
        if (pending[connId + '|' + rule.set] === out) continue;   // in flight
        actions.push({ property: rule.set, value: out, connId });
      }
      continue;
    }
    const input = rule.aggregate ? aggregateInput(rule, state, perConn) : state[rule.when];
    if (input === undefined || input === null) continue; // nothing to react to yet
    const out = rule.map ? (rule.map[String(input)] ?? String(input)) : String(input);
    if (state[rule.set] === out) continue;      // already converged
    if (pending[rule.set] === out) continue;    // put in flight, waiting for echo
    actions.push({ property: rule.set, value: out });
  }
  return actions;
}

/**
 * Drop pending entries that the state now confirms (echo arrived).
 * Mutates and returns `pending`.
 */
export function reconcilePending(state, pending, perConn = {}) {
  for (const p in pending) {
    const bar = p.indexOf('|');
    if (bar !== -1) {
      // connection-scoped pending: "<connId>|<prop>", confirmed by perConn
      const connId = p.slice(0, bar);
      const prop = p.slice(bar + 1);
      if (perConn[connId] && perConn[connId][prop] === pending[p]) delete pending[p];
      continue;
    }
    if (state[p] === pending[p]) delete pending[p];
  }
  return pending;
}
