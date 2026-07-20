// core/widget-spec.js
// ---------------------------------------------------------------------------
// PORTABLE (no Electron, no Node APIs). Validates a parsed widget definition
// against CP profiles fetched from the registry (cp.padi.io), and produces a
// serializable "model" the rest of the app (main process, renderer, any future
// mobile shell) consumes.
//
// A widget definition is plain data (authored as YAML, parsed elsewhere):
//
//   widget: bulb                    # id slug
//   title: Virtual Bulb
//   description: ...
//   capabilities:
//     - profile: padi.light         # MUST resolve from cp.padi.io/profiles/<name>
//       role: consumer              # provider | consumer
//   view:                           # faceplate, list of primitives
//     - { type: lamp,   bind: sOut, on: "1" }
//     - { type: label,  bind: sLabel }
//     - { type: value,  bind: cState, caption: reported state }
//   behavior:                       # optional auto-actualize
//     init:  { cState: "0" }        # puts issued once, at instantiation
//     rules:                        # convergence rules, run on every update
//       - { when: sOut, set: cState }             # mirror
//       # - { when: x, set: y, map: {"1":"open"} } # optional value mapping
//
// HARD RULE (project): a profile absent from the registry fails validation —
// widgets are never built against an unregistered CP.
// ---------------------------------------------------------------------------

const ROLES = ['provider', 'consumer'];
// Interactive primitives render as controls when the bound property is
// writable by this widget's role, and as read-only displays otherwise
// (except toggle/field, which REQUIRE a writable bind).
const PRIMITIVES = ['lamp', 'toggle', 'value', 'label', 'field', 'meter', 'options', 'image', 'date', 'stepper', 'split'];

/**
 * Extract the property map from a registry profile JSON (latest version).
 * The registry encodes per-property flags by KEY PRESENCE (value is null):
 *  - "server" present  -> the SERVER (provider) side writes this property;
 *    absent -> the client (consumer) writes it.
 *  - "propagate" present -> writes to this property are propagated to all
 *    active connections; absent -> the value stays on the node's capability
 *    and NEVER reaches connections (peers cannot see it).
 *  - "required" present -> the property is required.
 * @param {object} profileJson raw JSON from cp.padi.io/profiles/<name>
 * @returns {{title:string, props:Object<string,{writer:'server'|'client', desc:string, propagate:boolean, required:boolean}>}|null}
 */
export function parseProfile(profileJson) {
  if (!profileJson || !Array.isArray(profileJson.versions) || !profileJson.versions.length) {
    return null;
  }
  const latest = profileJson.versions[profileJson.versions.length - 1] || {};
  const props = {};
  for (const pr of latest.properties || []) {
    if (!pr || !pr.name) continue;
    props[pr.name] = {
      writer: 'server' in pr ? 'server' : 'client',
      desc: pr.description || '',
      propagate: 'propagate' in pr,
      required: 'required' in pr,
    };
  }
  return { title: profileJson.title || '', props };
}

/** Does `role` write `prop` under this profile? provider↔server, consumer↔client. */
function roleWrites(role, propInfo) {
  return (role === 'provider') === (propInfo.writer === 'server');
}

/**
 * Validate a parsed widget definition.
 * @param {object} raw parsed YAML (plain object)
 * @param {Object<string, object|null>} profileJsons map profile name -> raw
 *   registry JSON (null/undefined = not in registry / fetch failed)
 * @returns {{ok:boolean, errors:string[], model:object|null}}
 *   model (serializable) = {
 *     id, title, description,
 *     capabilities: [{profile, role, title, props:{name:{writer,desc}}}],
 *     resolve: { propName: {profile, role, writer, desc} },  // unambiguous binds
 *     writable: [propName],   // props THIS widget may put
 *     view: [...normalized primitives],
 *     behavior: { init:{}, rules:[] },
 *   }
 */
export function validateDefinition(raw, profileJsons) {
  const errors = [];
  const e = (msg) => errors.push(msg);

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Definition is not a mapping.'], model: null };
  }

  const id = typeof raw.widget === 'string' ? raw.widget.trim() : '';
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    e('`widget:` must be a slug (letters, digits, ., _, -).');
  }
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id;
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  // Optional visual identity: an icon (emoji / short string) and accent color.
  let icon = '';
  if (raw.icon != null) {
    icon = String(raw.icon).trim();
    if (icon.length > 8) e('`icon:` must be a short string (an emoji or a couple of characters).');
  }
  let color = '';
  if (raw.color != null) {
    color = String(raw.color).trim();
    if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) {
      e('`color:` must be a hex color like #f5b34c.');
    }
  }

  // ---- capabilities ----
  const capsIn = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  if (!capsIn.length) e('`capabilities:` must list at least one { profile, role }.');
  const capabilities = [];
  const seen = new Set();
  for (const c of capsIn) {
    const profile = c && typeof c.profile === 'string' ? c.profile.trim() : '';
    const role = c && typeof c.role === 'string' ? c.role.trim() : '';
    if (!profile) { e('A capability is missing `profile:`.'); continue; }
    if (!ROLES.includes(role)) { e(`Capability "${profile}": role must be provider|consumer (got "${role}").`); continue; }
    const key = profile + '|' + role;
    if (seen.has(key)) { e(`Duplicate capability ${role} of "${profile}".`); continue; }
    seen.add(key);
    const parsed = parseProfile(profileJsons ? profileJsons[profile] : null);
    if (!parsed) {
      e(`Profile "${profile}" is NOT in the CP registry (cp.padi.io/profiles/${profile}) — refusing it.`);
      continue;
    }
    capabilities.push({ profile, role, title: parsed.title, props: parsed.props });
  }

  // ---- bind resolution: bare property names must be unambiguous ----
  const resolve = {}; // prop -> {profile, role, writer, propagate, required, desc} | 'AMBIGUOUS'
  for (const cap of capabilities) {
    for (const p in cap.props) {
      if (resolve[p]) resolve[p] = 'AMBIGUOUS';
      else {
        resolve[p] = {
          profile: cap.profile,
          role: cap.role,
          writer: cap.props[p].writer,
          propagate: !!cap.props[p].propagate,
          required: !!cap.props[p].required,
          desc: cap.props[p].desc,
        };
      }
    }
  }
  const resolveBind = (prop, where) => {
    const r = resolve[prop];
    if (!r) { e(`${where}: property "${prop}" does not exist in any declared capability.`); return null; }
    if (r === 'AMBIGUOUS') { e(`${where}: property "${prop}" exists in more than one capability — ambiguous.`); return null; }
    return r;
  };
  const writable = [];
  for (const p in resolve) {
    const r = resolve[p];
    if (r !== 'AMBIGUOUS' && roleWrites(r.role, { writer: r.writer })) writable.push(p);
  }
  const assertWritable = (prop, where) => {
    const r = resolveBind(prop, where);
    if (r && !roleWrites(r.role, { writer: r.writer })) {
      e(`${where}: "${prop}" is written by the ${r.writer === 'server' ? 'provider' : 'consumer'} side; this widget's ${r.role} role may not write it.`);
      return null;
    }
    return r;
  };
  // Reading a PEER-written property only works if the CP propagates it —
  // otherwise the value never reaches this widget's connections, so a display
  // could never show it and a rule could never fire. Refuse such binds.
  const assertReadable = (prop, where) => {
    const r = resolveBind(prop, where);
    if (!r) return null;
    const own = roleWrites(r.role, { writer: r.writer });
    if (!own && !r.propagate) {
      e(`${where}: "${prop}" is written by the peer side but the CP does not set its propagate flag — the value never reaches this widget's connections, so it can never appear here.`);
      return null;
    }
    return r;
  };

  // ---- view ----
  const viewIn = Array.isArray(raw.view) ? raw.view : [];
  if (!viewIn.length) e('`view:` must list at least one primitive.');
  const view = [];
  viewIn.forEach((v, i) => {
    const where = `view[${i}]`;
    const type = v && typeof v.type === 'string' ? v.type.trim() : '';
    if (!PRIMITIVES.includes(type)) { e(`${where}: unknown primitive "${type}" (allowed: ${PRIMITIVES.join(', ')}).`); return; }
    const prim = { type };
    if (typeof v.caption === 'string') prim.caption = v.caption;

    if (type === 'split') {
      // Layout marker: starts the second column (you | them faceplates).
      view.push(prim);
      return;
    }
    if (type === 'label') {
      if (typeof v.text === 'string') prim.text = v.text;
      else if (typeof v.bind === 'string' && assertReadable(v.bind, where)) prim.bind = v.bind;
      else { e(`${where}: label needs \`text:\` or a valid \`bind:\`.`); return; }
    } else {
      if (typeof v.bind !== 'string' || !v.bind.trim()) { e(`${where}: ${type} requires \`bind:\`.`); return; }
      prim.bind = v.bind.trim();
      if (type === 'toggle' || type === 'field') {
        if (!assertWritable(prim.bind, where)) return;
      } else if (!assertReadable(prim.bind, where)) return;
    }
    if (type === 'lamp' || type === 'toggle') {
      prim.on = v.on != null ? String(v.on) : '1';
      prim.off = v.off != null ? String(v.off) : '0';
    }
    if (type === 'meter') {
      prim.min = Number.isFinite(Number(v.min)) ? Math.trunc(Number(v.min)) : 0;
      prim.max = Number.isFinite(Number(v.max)) ? Math.trunc(Number(v.max)) : 5;
      if (prim.max <= prim.min) { e(`${where}: meter needs max > min.`); return; }
      if (prim.max - prim.min > 20) { e(`${where}: meter range is limited to 20 steps.`); return; }
    }
    if (type === 'options') {
      const vals = Array.isArray(v.values) ? v.values.map((x) => String(x)) : null;
      if (!vals || !vals.length) { e(`${where}: options requires a non-empty \`values:\` list.`); return; }
      if (vals.length > 24) { e(`${where}: options is limited to 24 values.`); return; }
      prim.values = vals;
    }
    if (type === 'stepper') {
      if (v.min != null) prim.min = Number(v.min);
      if (v.max != null) prim.max = Number(v.max);
      prim.step = v.step != null && Number.isFinite(Number(v.step)) ? Number(v.step) : 1;
    }
    view.push(prim);
  });

  // ---- behavior ----
  const behavior = { init: {}, rules: [] };
  const b = raw.behavior;
  if (b != null) {
    if (typeof b !== 'object' || Array.isArray(b)) e('`behavior:` must be a mapping with optional `init:` and `rules:`.');
    else {
      if (b.init != null) {
        if (typeof b.init !== 'object' || Array.isArray(b.init)) e('`behavior.init:` must map property -> value.');
        else for (const p in b.init) {
          if (assertWritable(p, 'behavior.init')) behavior.init[p] = String(b.init[p]);
        }
      }
      const rules = Array.isArray(b.rules) ? b.rules : [];
      rules.forEach((r, i) => {
        const where = `behavior.rules[${i}]`;
        const when = r && typeof r.when === 'string' ? r.when.trim() : '';
        const set = r && typeof r.set === 'string' ? r.set.trim() : '';
        if (!when || !set) { e(`${where}: needs \`when:\` and \`set:\`.`); return; }
        if (when === set) { e(`${where}: \`when\` and \`set\` must differ.`); return; }
        if (!assertReadable(when, where)) return;
        if (!assertWritable(set, where)) return;
        const rule = { when, set };
        if (r.map != null) {
          if (typeof r.map !== 'object' || Array.isArray(r.map)) { e(`${where}: \`map:\` must be a mapping.`); return; }
          rule.map = {};
          for (const k in r.map) rule.map[String(k)] = String(r.map[k]);
        }
        if (r.aggregate != null) {
          const agg = String(r.aggregate).trim();
          // Aggregates compute the input across ALL connections' values of
          // `when` (numeric only; non-numeric falls back to the merged view).
          if (!['average', 'min', 'max'].includes(agg)) {
            e(`${where}: \`aggregate:\` must be one of average, min, max.`);
            return;
          }
          rule.aggregate = agg;
        }
        behavior.rules.push(rule);
      });
    }
  }

  if (errors.length) return { ok: false, errors, model: null };
  return {
    ok: true,
    errors: [],
    model: { id, title, description, icon, color, capabilities, resolve, writable, view, behavior },
  };
}
