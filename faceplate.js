// faceplate.js — renders ONE virtual widget from its definition's `view`
// primitives, live off the state pushed by the main process. This window is
// only a view: the widget itself (behavior, reporting) lives in main and keeps
// running when this window is closed.
//
// Primitives: lamp, toggle, value, label, field, meter, options, image, date,
// stepper — interactive when the bound property is writable by this widget's
// role, read-only displays otherwise — plus `split` (starts a second column).

const $ = (id) => document.getElementById(id);

let fp = null;              // bootstrap payload
let state = {};             // the EFFECTIVE view (merged, or one connection's)
let merged = {};            // merged state as pushed by main
let perConn = {};           // connId -> that connection's property map
let peers = [];             // [{connId, system, node, profile}]
let selByProfile = {};      // profile -> 'all' | connId (independent pill groups per CP)
let groupsList = [];        // [{profile, peers:[...]}] — only CPs with 2+ OWN connections
let bindProfile = {};       // bind -> owning profile (from the bootstrap payload)
let mixedMap = {};          // bind -> [distinct values] when peers disagree (All view)
let rtts = {};              // echo prop -> { connId: ms } (round-trip times, app-measured)
let peerWritten = new Set(); // binds NOT writable by this widget = written by peers
let allBinds = new Set();   // every bound property in the view (mixed applies to all)
const updaters = [];        // fns called with (state) on every push

function chip(connections, attached) {
  const el = $('fpChip');
  if (!attached) { el.className = 'chip off'; el.textContent = 'offline'; }
  else if (connections > 0) { el.className = 'chip ok'; el.textContent = 'bound · ' + connections; }
  else { el.className = 'chip wait'; el.textContent = 'awaiting broker'; }
}

// A pill group is only meaningful for a CP with 2+ of ITS OWN connections —
// within a single-connection CP there is nothing to disambiguate (the merged
// view IS that connection, and a write can only go one place). This is also
// what keeps multi-CP widgets like the Tenant Light strip-free.
function rebuildGroups() {
  const by = new Map();
  for (const p of peers) {
    if (!by.has(p.profile)) by.set(p.profile, []);
    by.get(p.profile).push(p);
  }
  groupsList = [...by.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([profile, list]) => ({ profile, peers: list }));
  for (const g of groupsList) {
    const sel = selByProfile[g.profile];
    if (sel && sel !== 'all' && !g.peers.some((p) => p.connId === sel)) delete selByProfile[g.profile];
  }
}
const selFor = (profile) => selByProfile[profile] || 'all';
// The group a bound property belongs to. Falls back to the single rendered
// group when the payload carries no bind->profile map (older main process).
function groupFor(bind) {
  const prof = bindProfile[bind];
  if (prof) return groupsList.find((g) => g.profile === prof) || null;
  return groupsList.length === 1 ? groupsList[0] : null;
}
const shortProfile = (name) => {
  const parts = String(name).split('.');
  return parts.length > 1 ? parts.slice(1).join('.') : String(name);
};

function peersLine() {
  const el = $('fpPeers');
  // With pill groups visible the footer line is redundant.
  if (!peers.length || groupsList.length) { el.textContent = ''; return; }
  el.textContent = peers.length === 1
    ? `bound to ${peers[0].system} · ${peers[0].node}`
    : 'bound to ' + peers.map((p) => p.node).join(' · ');
}

// The peer strip: appears only at 2+ connections. "All" aggregates; a peer
// chip filters the read side to that single connection.
// When the strip appears/disappears mid-session, the WINDOW grows/shrinks by
// the strip's height so the content area keeps its size (no scrollbars).
let stripShown = false;
let stripEverRendered = false; // first render sets the baseline — no resize
function renderStrip() {
  rebuildGroups();
  const strip = $('fpStrip');
  if (!groupsList.length) {
    if (stripShown && stripEverRendered) {
      const h = strip.offsetHeight;
      strip.hidden = true;
      if (h && window.faceplate.adjustHeight) window.faceplate.adjustHeight(-h);
    } else {
      strip.hidden = true;
    }
    stripShown = false;
    stripEverRendered = true;
    return;
  }
  const wasShown = stripShown;
  strip.hidden = false;
  strip.innerHTML = '';
  stripShown = true;
  if (!wasShown && stripEverRendered && window.faceplate.adjustHeight) {
    requestAnimationFrame(() => {
      const h = strip.offsetHeight;
      if (h) window.faceplate.adjustHeight(h);
    });
  }
  stripEverRendered = true;
  const mk = (profile, id, label, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'peer' + (selFor(profile) === id ? ' on' : '');
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', () => {
      selByProfile[profile] = id;
      renderStrip();
      computeView();
      for (const fn of updaters) fn(state);
    });
    return b;
  };
  // One compact group per multi-connection CP, all on one wrapping row.
  // Selection is INDEPENDENT per group; reads/writes of a property resolve
  // against its OWN CP's selection only. Pill label = NODE name (system
  // names are often identical across peers); full detail in the tooltip.
  for (const g of groupsList) {
    const grp = el('span', 'peer-group');
    if (groupsList.length > 1) {
      const tag = el('span', 'gtag', shortProfile(g.profile));
      tag.title = g.profile;
      grp.appendChild(tag);
    }
    grp.appendChild(mk(g.profile, 'all', `All · ${g.peers.length}`, `aggregate view of every ${g.profile} connection`));
    for (const p of g.peers) grp.appendChild(mk(g.profile, p.connId, p.node, `${p.system} · ${p.node} (${p.profile})`));
    strip.appendChild(grp);
  }
}

// Build the effective state for the current selection, and the mixed map for
// the All view (peer-written props where connections disagree).
function computeView() {
  mixedMap = {};
  state = { ...merged };
  // Overlay each group's selected connection. Connection property maps are
  // naturally scoped to their capability, so overlaying a lease connection
  // can never disturb light properties.
  for (const g of groupsList) {
    const sel = selFor(g.profile);
    if (sel !== 'all' && perConn[sel]) Object.assign(state, perConn[sel]);
  }
  // Mixed detection runs WITHIN a property's own CP group — disagreement
  // between unrelated CPs' connections is not a conflict.
  for (const bind of allBinds) {
    const g = groupFor(bind);
    if (!g || selFor(g.profile) !== 'all') continue;
    const vals = new Set();
    for (const p of g.peers) {
      const pc = perConn[p.connId];
      if (pc && pc[bind] !== undefined) vals.add(pc[bind]);
    }
    if (vals.size > 1) mixedMap[bind] = [...vals];
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function wrap(prim, child) {
  const box = el('div', 'prim');
  box.appendChild(child);
  if (prim.caption) box.appendChild(el('div', 'caption', prim.caption));
  // Own-written property the CP does not propagate: honest "local" marker.
  if (prim.bind && fp.localOnly && fp.localOnly.includes(prim.bind)) {
    const lc = el('span', 'chip-local', 'local');
    lc.title = 'no propagate flag in the CP — capability writes are not broadcast to connections; deliver it per-connection (addressed) instead';
    box.appendChild(lc);
  }
  return box;
}

// Flash an element when its underlying value changes (elements are mutated in
// place, never re-rendered, so a timed class here is safe).
const flashTimers = new Map();
function flash(node) {
  node.classList.add('hot');
  clearTimeout(flashTimers.get(node));
  flashTimers.set(node, setTimeout(() => node.classList.remove('hot'), 1200));
}
function watch(prim, fn) {
  let prev;
  let prevMixed = false;
  let first = true;
  updaters.push((s) => {
    const mixed = !!mixedMap[prim.bind];
    const raw = s[prim.bind];
    fn(raw, !first && !mixed && !prevMixed && raw !== prev, mixed, mixedMap[prim.bind]);
    prev = raw;
    prevMixed = mixed;
    first = false;
  });
}

// Breakdown tooltip for a mixed value: '2× "1" · 1× "0"'.
function mixedTitle(prim) {
  const g = groupFor(prim.bind);
  const counts = {};
  for (const p of (g ? g.peers : peers)) {
    const pc = perConn[p.connId];
    const v = pc ? pc[prim.bind] : undefined;
    if (v !== undefined) counts[v] = (counts[v] || 0) + 1;
  }
  return Object.entries(counts).map(([v, n]) => `${n}× "${v}"`).join(' · ');
}

function act(prim, value) {
  // A selected peer pill scopes the write to that ONE connection (the control
  // plane mirrors connection properties 1:1); All = capability broadcast.
  // The selection consulted is the one on the PROPERTY'S OWN CP group — a
  // pill selected on some other CP's group can never misaddress this write.
  const g = groupFor(prim.bind);
  const sel = g ? selFor(g.profile) : 'all';
  window.faceplate.action(prim.bind, String(value), sel !== 'all' ? sel : null).catch(() => {});
}

const BUILDERS = {
  lamp(prim) {
    const lamp = el('div', 'lamp');
    watch(prim, (raw, _c, mixed) => {
      lamp.classList.toggle('mixed', mixed);
      lamp.classList.toggle('on', !mixed && raw === prim.on);
      lamp.title = mixed ? 'mixed: ' + mixedTitle(prim) : '';
    });
    return lamp;
  },

  toggle(prim, writable) {
    const t = el('button', 'toggle');
    t.type = 'button';
    t.setAttribute('aria-label', prim.caption || prim.bind);
    t.disabled = !writable;
    t.addEventListener('click', () => act(prim, state[prim.bind] === prim.on ? prim.off : prim.on));
    watch(prim, (raw, _c, mixed) => {
      t.classList.toggle('mixed', mixed);
      t.classList.toggle('on', !mixed && raw === prim.on);
      t.title = mixed ? 'mixed: ' + mixedTitle(prim) : '';
    });
    return t;
  },

  value(prim) {
    const v = el('div', 'value empty', '—');
    watch(prim, (raw, changed, mixed) => {
      v.classList.toggle('mixed', mixed);
      if (mixed) {
        v.classList.remove('empty');
        v.textContent = 'mixed';
        v.title = mixedTitle(prim);
        return;
      }
      v.title = '';
      const empty = raw === undefined || raw === null || raw === '';
      v.classList.toggle('empty', empty);
      v.textContent = empty ? '—' : String(raw);
      if (changed) flash(v);
    });
    return v;
  },

  label(prim) {
    const l = el('div', 'labelval', prim.text || '—');
    if (prim.bind) {
      watch(prim, (raw, changed, mixed) => {
        l.textContent = mixed ? 'mixed' : raw ? String(raw) : '—';
        l.title = mixed ? mixedTitle(prim) : '';
        if (changed) flash(l);
      });
    }
    return l;
  },

  field(prim, writable) {
    const boxIn = el('div', 'field');
    const input = document.createElement('input');
    input.type = 'text';
    input.disabled = !writable;
    const commit = () => {
      if (input.value !== (state[prim.bind] ?? '')) act(prim, input.value);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); input.blur(); } });
    input.addEventListener('blur', commit);
    updaters.push((s) => { if (document.activeElement !== input) input.value = s[prim.bind] ?? ''; });
    boxIn.appendChild(input);
    return boxIn;
  },

  meter(prim, writable) {
    const box = el('div', 'meter' + (writable ? ' rw' : ''));
    const segs = [];
    for (let v = prim.min; v <= prim.max; v++) {
      const s = el('button', 'seg');
      s.type = 'button';
      s.disabled = !writable;
      s.title = String(v);
      if (writable) s.addEventListener('click', () => act(prim, v));
      box.appendChild(s);
      segs.push({ v, node: s });
    }
    const num = el('span', 'meter-num', '—');
    box.appendChild(num);
    watch(prim, (raw, changed, mixed) => {
      if (mixed) {
        for (const s of segs) s.node.classList.remove('lit');
        num.textContent = 'mix';
        num.title = mixedTitle(prim);
        num.classList.add('mixed');
        return;
      }
      num.classList.remove('mixed');
      num.title = '';
      const n = Number(raw);
      const has = raw !== undefined && raw !== '' && Number.isFinite(n);
      for (const s of segs) s.node.classList.toggle('lit', has && s.v <= n && s.v > prim.min - 1 && n >= prim.min);
      num.textContent = has ? String(n) : '—';
      if (changed) flash(num);
    });
    return box;
  },

  options(prim, writable) {
    // Few values + writable -> segmented buttons; many values -> a dropdown;
    // read-only -> a badge showing the current value.
    if (!writable) {
      const b = el('span', 'opt-badge', '—');
      watch(prim, (raw, changed, mixed) => {
        b.classList.toggle('mixed', mixed);
        b.textContent = mixed ? 'mixed' : raw || '—';
        b.title = mixed ? mixedTitle(prim) : '';
        if (changed) flash(b);
      });
      return b;
    }
    if (prim.values.length <= 4) {
      const box = el('div', 'opt-seg');
      const btns = prim.values.map((v) => {
        const b = el('button', 'opt', v);
        b.type = 'button';
        b.addEventListener('click', () => act(prim, v));
        box.appendChild(b);
        return b;
      });
      watch(prim, (raw) => btns.forEach((b) => b.classList.toggle('on', b.textContent === raw)));
      return box;
    }
    const sel = document.createElement('select');
    sel.className = 'opt-sel';
    sel.appendChild(new Option('—', ''));
    for (const v of prim.values) sel.appendChild(new Option(v, v));
    sel.addEventListener('change', () => { if (sel.value) act(prim, sel.value); });
    watch(prim, (raw) => {
      const v = raw ?? '';
      if ([...sel.options].some((o) => o.value === v)) sel.value = v;
    });
    return sel;
  },

  image(prim) {
    const box = el('div', 'imgbox');
    const img = document.createElement('img');
    img.alt = prim.caption || prim.bind;
    img.addEventListener('error', () => box.classList.add('broken'));
    watch(prim, (raw) => {
      const url = (raw || '').trim();
      box.classList.remove('broken');
      box.classList.toggle('empty', !url);
      if (url && /^https:\/\//i.test(url)) img.src = url;
      else img.removeAttribute('src');
    });
    box.appendChild(img);
    return box;
  },

  date(prim, writable) {
    if (!writable) return BUILDERS.value(prim);
    const boxIn = el('div', 'field');
    const input = document.createElement('input');
    input.type = 'date';
    input.addEventListener('change', () => act(prim, input.value));
    updaters.push((s) => {
      if (document.activeElement !== input) {
        const raw = s[prim.bind] ?? '';
        input.value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
      }
    });
    boxIn.appendChild(input);
    return boxIn;
  },

  stepper(prim, writable) {
    const box = el('div', 'stepper');
    const minus = el('button', 'step-btn', '−');
    const num = el('span', 'step-num', '—');
    const plus = el('button', 'step-btn', '+');
    minus.type = plus.type = 'button';
    minus.disabled = plus.disabled = !writable;
    const bump = (dir) => {
      const cur = Number(state[prim.bind]);
      let next = (Number.isFinite(cur) ? cur : (prim.min ?? 0)) + dir * prim.step;
      if (prim.min != null) next = Math.max(prim.min, next);
      if (prim.max != null) next = Math.min(prim.max, next);
      act(prim, next);
    };
    minus.addEventListener('click', () => bump(-1));
    plus.addEventListener('click', () => bump(1));
    watch(prim, (raw, changed) => {
      num.textContent = raw === undefined || raw === '' ? '—' : String(raw);
      if (changed) flash(num);
    });
    box.append(minus, num, plus);
    return box;
  },

  // Round-trip meter: send → responder → back on the same connection, timed
  // by the app at both ends of the write. Scope follows the peer strip: a
  // selected peer shows THAT connection's time; All summarizes the range.
  rtt(prim) {
    const v = el('div', 'value rtt empty', '—');
    let prevText = null;
    updaters.push(() => {
      const times = rtts[prim.echo] || {};
      let text = '—';
      let title = '';
      const g = groupFor(prim.echo);
      const scope = g ? g.peers
        : bindProfile[prim.echo] ? peers.filter((p) => p.profile === bindProfile[prim.echo]) : peers;
      const sel = g ? selFor(g.profile) : 'all';
      if (sel !== 'all') {
        text = times[sel] !== undefined ? `${times[sel]} ms` : '—';
      } else {
        const measured = scope.filter((p) => times[p.connId] !== undefined);
        if (measured.length === 1) {
          text = `${times[measured[0].connId]} ms`;
          title = `${measured[0].node}: ${times[measured[0].connId]} ms`;
        } else if (measured.length > 1) {
          const ms = measured.map((p) => times[p.connId]);
          const lo = Math.min(...ms);
          const hi = Math.max(...ms);
          text = lo === hi ? `${lo} ms` : `${lo}–${hi} ms`;
          title = measured.map((p) => `${p.node}: ${times[p.connId]} ms`).join(' · ');
        } else if (Object.keys(times).length === 1) {
          // times exist but the peer list hasn't caught up — show them anyway
          text = `${Object.values(times)[0]} ms`;
        }
      }
      v.textContent = text;
      v.title = title;
      v.classList.toggle('empty', text === '—');
      if (prevText !== null && text !== prevText && text !== '—') flash(v);
      prevText = text;
    });
    return v;
  },
};

function build() {
  const body = $('fpBody');
  body.innerHTML = '';
  const hasSplit = fp.view.some((v) => v.type === 'split');
  let col = el('div', 'fp-col');
  body.appendChild(col);
  if (hasSplit) body.classList.add('cols');
  for (const prim of fp.view) {
    if (prim.type === 'split') {
      col = el('div', 'fp-col');
      body.appendChild(col);
      continue;
    }
    const builder = BUILDERS[prim.type];
    if (!builder) continue;
    const writable = prim.bind ? fp.writable.includes(prim.bind) : false;
    col.appendChild(wrap(prim, builder(prim, writable)));
  }
}

function apply(payload) {
  merged = payload.state || {};
  perConn = payload.perConn || {};
  if (payload.peers) peers = payload.peers;
  if (payload.rtt) rtts = payload.rtt;
  computeView();
  for (const fn of updaters) fn(state);
}

async function init() {
  fp = await window.faceplate.load();
  if (!fp) {
    document.body.innerHTML = '<p style="padding:20px;color:#9aa6b4">This widget no longer exists.</p>';
    return;
  }
  $('fpName').textContent = fp.name;
  $('fpKind').textContent = fp.title + ' · ' + fp.contextName;
  if (fp.icon) { $('fpIcon').textContent = fp.icon; $('fpIcon').hidden = false; }
  if (fp.color) document.body.style.setProperty('--fp-accent', fp.color);
  $('fpAuto').hidden = !fp.hasRules;
  document.title = fp.name;
  document.body.classList.toggle('light', fp.theme === 'light');

  let pinned = !!fp.pinned;
  const pinBtn = $('fpPin');
  pinBtn.classList.toggle('on', pinned);
  pinBtn.addEventListener('click', async () => {
    pinned = await window.faceplate.setPinned(!pinned);
    pinBtn.classList.toggle('on', pinned);
  });
  $('fpClose').addEventListener('click', () => window.close());

  peerWritten = new Set(
    fp.view.filter((v) => v.bind && !fp.writable.includes(v.bind)).map((v) => v.bind)
  );
  allBinds = new Set(fp.view.filter((v) => v.bind).map((v) => v.bind));
  bindProfile = fp.bindProfile || {};
  peers = fp.peers || [];
  build();
  chip(fp.connections, fp.attached);
  peersLine();
  renderStrip();
  apply({ state: fp.state, perConn: fp.perConn, peers: fp.peers, rtt: fp.rtt });
  window.faceplate.onState(({ state: s, connections, peers: p, perConn: pc, rtt }) => {
    chip(connections, true);
    peers = p || [];
    peersLine();
    renderStrip();
    apply({ state: s, perConn: pc, peers: p, rtt });
  });
  if (window.faceplate.onTheme) {
    window.faceplate.onTheme((theme) => document.body.classList.toggle('light', theme === 'light'));
  }
  // The bootstrap above runs once — identity edits (rename / context move via
  // the main window's Edit dialog) arrive here. Text-only mutation, per the
  // no-re-render rule: the view/controls (and any user focus) stay untouched.
  if (window.faceplate.onInfo) {
    window.faceplate.onInfo(({ name, contextName }) => {
      fp.name = name;
      fp.contextName = contextName;
      $('fpName').textContent = name;
      $('fpKind').textContent = fp.title + ' · ' + contextName;
      document.title = name;
    });
  }
}

init();
