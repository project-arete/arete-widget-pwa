// browser-widget-bridge.js — the PWA replacement for the Widget app's Electron
// layer (main.js + arete-service.js + widget-manager.js + both preloads).
// Implements the same `window.arete` bridge the renderer expects, a browser
// port of the Arete SDK client, a localStorage-backed widget manager, and
// faceplates as in-page overlay iframes instead of separate windows.
//
// Ported semantics preserved from the desktop app:
//   - capability re-declaration is NOT idempotent (it wipes values) — attach
//     SKIPS declaration when the capability already exists on the realm (v29)
//   - per-connection control writes .../connections/<id>/properties/<prop> (v26)
//   - aggregate rules run on perConn (v27); identity edits push to open
//     faceplates (v25)

import { validateDefinition } from './core/widget-spec.js';
import { deriveState, computeActions, reconcilePending } from './core/behavior-engine.js';
import yaml from './js-yaml.mjs';

const LS_SETTINGS = 'arete-widget-settings';
const LS_INSTANCES = 'arete-widget-instances';
const LS_IDENTITY = 'arete-widget-system';
const LIBRARY_DEFAULT = 'https://project-arete.github.io/widget-library';
const RETRY_MS = 5000;
const KEYS_DEBOUNCE_MS = 400;

// ------------------------------------------------------------- tiny emitter
class Emitter {
  #h = {};
  on(ev, fn) { (this.#h[ev] || (this.#h[ev] = [])).push(fn); return this; }
  emit(ev, ...args) { for (const fn of [...(this.#h[ev] || [])]) fn(...args); return this; }
}

// ---------------------------------------------------- SDK merge (ported 1:1)
const getType = (v) => Object.prototype.toString.call(v);
function merge(target, source) {
  for (const key in source) {
    const value = source[key];
    const type = getType(value);
    if (type === '[object Null]') delete target[key];
    else if (type === '[object Object]') {
      if (getType(target[key]) !== type || Object.keys(value).length === 0) target[key] = {};
      merge(target[key], value);
    } else target[key] = value;
  }
}

// --------------------------------------------- browser port of the SDK client
class BrowserAreteClient extends Emitter {
  constructor(url) {
    super();
    this.url = url; this.userClosed = false; this.socket = undefined;
    this.#reset(); this.open();
  }
  #reset() {
    if (this.requests) for (const t in this.requests) this.requests[t].reject(new Error('Socket request failed'));
    this.transaction = 1; this.requests = {}; this.updates = 0;
    this.cache = { version: '', stats: {}, keys: {} };
  }
  open() {
    if (this.socket !== undefined || this.userClosed) return;
    this.#reset();
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = (e) => this.#onmessage(e);
    this.socket.onclose = () => this.#onclose();
    this.socket.onerror = () => this.emit('error', new Error('Socket not open'));
  }
  async waitForOpen(timeout = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.updates > 0) return;
      if (this.userClosed) throw new Error('Connection cancelled');
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Failed to connect within timeout');
  }
  isOpen() { return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN; }
  get version() { return this.cache.version; }
  get stats() { return this.cache.stats; }
  get keys() { return this.cache.keys; }
  put(key, value) { return this.command('put', key, value); }
  command(cmd, ...args) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) return reject(new Error('Socket not open'));
      for (const arg of args) cmd += ' "' + arg + '"';
      const transaction = this.transaction++;
      this.requests[transaction] = { resolve, reject };
      this.socket.send(JSON.stringify({ transaction, format: 'json', command: cmd }));
    });
  }
  close() {
    this.userClosed = true;
    if (this.socket !== undefined) this.socket.close();
    this.socket = undefined;
  }
  #onmessage(e) {
    try {
      const data = JSON.parse(e.data);
      if (data.transaction !== undefined) {
        const req = this.requests[data.transaction];
        if (req) { delete this.requests[data.transaction]; req.resolve(data); }
        return;
      }
      merge(this.cache, data);
      if (this.updates++ === 0) this.emit('open', e);
      this.emit('update', data);
    } catch (err) { this.emit('error', err); }
  }
  #onclose() {
    const had = this.socket !== undefined;
    this.socket = undefined; this.#reset();
    if (this.userClosed) return;
    if (had) this.emit('close');
    setTimeout(() => this.open(), RETRY_MS);
  }
}

// -------------------------------------------------------------- persistence
const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (_) { return d; } };
const writeJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const readSettings = () => readJSON(LS_SETTINGS, {});
const writeSettings = (patch) => { const n = { ...readSettings(), ...patch }; writeJSON(LS_SETTINGS, n); return n; };

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function base62(len = 22) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = ''; for (const b of bytes) out += B62[b % 62]; return out;
}
function systemId() {
  let id = localStorage.getItem(LS_IDENTITY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(LS_IDENTITY, id); }
  return id;
}

// -------------------------------------------------------------- realm layer
const bus = new Emitter();
let client = null;
let state = 'disconnected';
let lastError = null;
let currentHost = '';
let systemName = '';
let keysTimer = null;
const profileCache = new Map();

const log = (level, message) => bus.emit('log', { level, message, ts: Date.now() });
const setState = (s) => { state = s; bus.emit('status', getStatus()); };
function getStatus() {
  return {
    state, isOpen: !!(client && client.isOpen()),
    version: client ? client.version || '' : '',
    stats: client ? client.stats || {} : {},
    identity: { system: state === 'connected' ? systemId() : null },
    lastError, host: currentHost,
  };
}
function getKeys() {
  const src = client && client.keys ? client.keys : {};
  const out = {};
  for (const k in src) { if (!k.endsWith('/token')) out[k] = src[k]; }
  return out;
}
function scheduleKeysPush() {
  if (keysTimer) return;
  keysTimer = setTimeout(() => {
    keysTimer = null;
    const keys = getKeys();
    bus.emit('keys', keys);
    manager.onKeys(keys);
  }, KEYS_DEBOUNCE_MS);
}
async function fetchProfile(name) {
  if (!name) return null;
  if (profileCache.has(name)) return profileCache.get(name);
  try {
    const res = await fetch('https://cp.padi.io/profiles/' + encodeURIComponent(name), { headers: { accept: 'application/json' } });
    const json = res.ok ? await res.json() : null;
    profileCache.set(name, json); return json;
  } catch (_) { profileCache.set(name, null); return null; }
}

// Minimal capability handle (get/put on the key path) — used both for fresh
// declarations and, crucially, for EXISTING capabilities we must not re-declare.
const capHandle = (base) => ({
  get: (p, d = null) => { const v = client.keys[`${base}/properties/${p}`]; return v === undefined ? d : v; },
  put: (p, v) => client.put(`${base}/properties/${p}`, String(v)),
});

const service = {
  async instantiate({ nodeId, nodeName, contextId, contextName, capabilities = [] }) {
    if (!client || !client.isOpen()) throw new Error('Not connected. Connect before adding widgets.');
    const sysId = systemId();
    await client.command('nodes', sysId, nodeId, nodeName, false, null);
    await client.command('contexts', sysId, nodeId, contextId, contextName);
    const caps = {};
    const keys = client.keys || {};
    for (const c of capabilities) {
      const base = `cns/${sysId}/nodes/${nodeId}/contexts/${contextId}/${c.role}/${c.profile}`;
      if (keys[base + '/version'] !== undefined) {
        // Capability already on the realm: re-declaring would WIPE its values.
        caps[`${c.role}|${c.profile}`] = capHandle(base);
        continue;
      }
      await client.command(c.role === 'provider' ? 'providers' : 'consumers', sysId, nodeId, contextId, c.profile);
      caps[`${c.role}|${c.profile}`] = capHandle(base);
    }
    return { systemId: sysId, caps };
  },
  async putKey(key, value) {
    if (!client || !client.isOpen()) throw new Error('Not connected.');
    if (typeof key !== 'string' || !key.startsWith('cns/')) throw new Error('Refusing to write a non-cns key.');
    return client.put(key, String(value));
  },
};

// ------------------------------------------------------------ widget manager
// A faithful browser port of electron/widget-manager.js: definitions from the
// bundled set + the online library (library overrides bundled, same as the
// desktop app), instances in localStorage, live handles + the behavior engine.
const manager = new (class extends Emitter {
  #defs = new Map();
  #instances = readJSON(LS_INSTANCES, []);
  #live = new Map();
  #lastKeys = {};
  #libraryUrl = LIBRARY_DEFAULT;
  #libraryCount = 0;
  #libraryUpdatedAt = null;

  setLibraryUrl(url) { this.#libraryUrl = (url ?? LIBRARY_DEFAULT).trim(); }
  libraryInfo() { return { url: this.#libraryUrl, updatedAt: this.#libraryUpdatedAt, count: this.#libraryCount }; }
  #log(level, message) { bus.emit('log', { level, message, ts: Date.now() }); }
  #save() { writeJSON(LS_INSTANCES, this.#instances); }

  async #loadSource(files) {
    const out = [];
    for (const { name, text, source } of files) {
      let raw;
      try { raw = yaml.load(text); } catch (e) {
        out.push({ id: name.replace(/\.ya?ml$/i, ''), source, ok: false, errors: ['YAML parse error: ' + (e.message || e)], title: name, description: '', model: null });
        continue;
      }
      const profiles = {};
      const wanted = new Set((Array.isArray(raw?.capabilities) ? raw.capabilities : []).map((c) => c && c.profile).filter(Boolean));
      for (const p of wanted) profiles[p] = await fetchProfile(p);
      const res = validateDefinition(raw, profiles);
      const id = res.model ? res.model.id : name.replace(/\.ya?ml$/i, '');
      out.push({ id, file: name, source, ok: res.ok, errors: res.errors, title: res.model ? res.model.title : id, description: res.model ? res.model.description : '', model: res.model });
    }
    return out;
  }

  async loadDefinitions() {
    const defs = new Map();
    // bundled (shipped with the app)
    try {
      const man = await fetch('./widgets/manifest.json').then((r) => r.json());
      const files = await Promise.all(man.files.map(async (f) => ({ name: f, source: 'bundled', text: await fetch('./widgets/' + f).then((r) => r.text()) })));
      for (const d of await this.#loadSource(files)) defs.set(d.id, d);
    } catch (e) { this.#log('warn', 'Bundled widgets failed to load: ' + (e.message || e)); }
    // online library (overrides bundled, exactly like the desktop app)
    if (this.#libraryUrl) {
      try {
        const base = this.#libraryUrl.replace(/\/+$/, '');
        const idx = await fetch(base + '/index.json', { headers: { accept: 'application/json' } }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
        const files = await Promise.all((idx.widgets || []).filter((w) => w && typeof w.file === 'string').map(async (w) => {
          const fname = w.file.split('/').pop();
          return { name: fname, source: 'library', text: await fetch(base + '/' + w.file).then((r) => r.text()) };
        }));
        let n = 0;
        for (const d of await this.#loadSource(files)) {
          if (defs.has(d.id)) this.#log('info', `Widget "${d.id}": library definition overrides the bundled one.`);
          defs.set(d.id, d); n++;
        }
        this.#libraryCount = n; this.#libraryUpdatedAt = new Date().getTime();
        this.#log('info', `Widget library refreshed — ${n} definition(s) from ${base}.`);
      } catch (e) { this.#log('warn', `Widget library refresh failed (${e.message || e}) — using bundled definitions.`); }
    }
    this.#defs = defs;
    const bad = [...defs.values()].filter((d) => !d.ok);
    this.#log('info', `Loaded ${defs.size} widget definition(s)` + (bad.length ? ` — ${bad.length} invalid.` : '.'));
    this.emit('defs', this.listDefinitions());
    return this.listDefinitions();
  }

  listDefinitions() {
    return [...this.#defs.values()].map((d) => ({
      id: d.id, file: d.file, source: d.source, ok: d.ok, errors: d.errors,
      title: d.title, description: d.description,
      icon: d.model ? d.model.icon || '' : '', color: d.model ? d.model.color || '' : '',
      capabilities: d.model ? d.model.capabilities.map((c) => ({ profile: c.profile, role: c.role, title: c.title })) : [],
      hasBehavior: !!(d.model && d.model.behavior.rules.length),
    }));
  }
  getModel(widgetId) { const d = this.#defs.get(widgetId); return d && d.ok ? d.model : null; }

  listInstances() {
    return this.#instances.map((inst) => {
      const live = this.#live.get(inst.id);
      const def = this.#defs.get(inst.widgetId);
      return {
        ...inst, attached: !!live,
        state: live ? live.state : {}, connections: live ? live.connections : 0,
        peers: live ? live.peers || [] : [], perConn: live ? live.perConn || {} : {},
        widgetOk: !!(def && def.ok), widgetTitle: def ? def.title : inst.widgetId,
      };
    });
  }
  getInstance(id) { return this.listInstances().find((i) => i.id === id) || null; }

  #peersFor(inst, model, keys) {
    const peers = [];
    for (const cap of model.capabilities) {
      const prefix = `cns/${inst.systemId}/nodes/${inst.nodeId}/contexts/${inst.contextId}/${cap.role}/${cap.profile}/connections/`;
      const peerSide = cap.role === 'provider' ? 'consumer' : 'provider';
      for (const k in keys) {
        if (!k.startsWith(prefix)) continue;
        const m = k.slice(prefix.length).match(/^([^/]+)\/(consumer|provider)$/);
        if (!m || m[2] !== peerSide) continue;
        const p = String(keys[k]).split('/');
        peers.push({ connId: m[1], profile: cap.profile, system: keys[`cns/${p[1]}/name`] || p[1], node: keys[`cns/${p[1]}/nodes/${p[3]}/name`] || p[3] });
      }
    }
    return peers;
  }

  async addInstance({ widgetId, name, contextId, contextName }) {
    const def = this.#defs.get(widgetId);
    if (!def || !def.ok) throw new Error(`Widget "${widgetId}" is not available.`);
    const instName = (name || '').trim();
    if (!instName) throw new Error('The widget needs a name (it becomes the Node name).');
    const inst = {
      id: base62(10), widgetId, name: instName,
      nodeId: base62(22),
      contextId: (contextId || '').trim() || base62(22),
      contextName: (contextName || '').trim() || instName,
      createdAt: new Date().toISOString(), initDone: false,
    };
    this.#instances.push(inst); this.#save();
    this.#log('info', `Widget "${instName}" (${widgetId}) created.`);
    try { await this.#attach(inst); } catch (e) { this.#log('warn', `Widget "${instName}" saved but not yet on the realm: ${e.message || e}`); }
    this.emit('instances', this.listInstances());
    return this.getInstance(inst.id);
  }

  async updateInstance({ id, name, contextId, contextName }) {
    const inst = this.#instances.find((i) => i.id === id);
    if (!inst) throw new Error('Unknown widget instance.');
    const newName = (name || '').trim();
    if (!newName) throw new Error('The widget needs a name.');
    const newCtxId = (contextId || '').trim() || inst.contextId;
    const newCtxName = (contextName || '').trim() || inst.contextName;
    const changed = newCtxId !== inst.contextId || newName !== inst.name || newCtxName !== inst.contextName;
    if (!changed) return this.getInstance(id);
    inst.name = newName; inst.contextId = newCtxId; inst.contextName = newCtxName;
    this.#save();
    this.#log('info', `Widget "${newName}" updated.`);
    if (this.#live.has(id)) {
      this.#live.delete(id);
      try { await this.#attach(inst); } catch (e) { this.#log('warn', `Re-attach failed: ${e.message || e}`); }
    }
    this.emit('instances', this.listInstances());
    return this.getInstance(id);
  }

  removeInstance(id) {
    const inst = this.#instances.find((i) => i.id === id);
    this.#live.delete(id);
    this.#instances = this.#instances.filter((i) => i.id !== id);
    this.#save();
    if (inst) this.#log('info', `Widget "${inst.name}" removed from this app (realm node not deleted).`);
    this.emit('instances', this.listInstances());
  }

  removeAllInstances() {
    const count = this.#instances.length;
    this.#live.clear(); this.#instances = []; this.#save();
    if (count) this.#log('info', `All ${count} widget(s) removed from this app (realm nodes not deleted).`);
    this.emit('instances', this.listInstances());
    return count;
  }

  async #attach(inst) {
    const def = this.#defs.get(inst.widgetId);
    if (!def || !def.ok) throw new Error(`Definition "${inst.widgetId}" unavailable.`);
    const { systemId: sysId, caps } = await service.instantiate({
      nodeId: inst.nodeId, nodeName: inst.name,
      contextId: inst.contextId, contextName: inst.contextName,
      capabilities: def.model.capabilities.map((c) => ({ profile: c.profile, role: c.role })),
    });
    inst.systemId = sysId;
    this.#live.set(inst.id, { caps, pending: {}, state: {}, connections: 0 });
    if (!inst.initDone) {
      for (const prop in def.model.behavior.init) await this.#put(inst, def.model, prop, def.model.behavior.init[prop]);
      inst.initDone = true; this.#save();
    }
    this.#processInstance(inst, this.#lastKeys);
  }

  async attachAll() {
    for (const inst of this.#instances) {
      try { await this.#attach(inst); } catch (e) { this.#log('warn', `Could not attach "${inst.name}": ${e.message || e}`); }
    }
    this.emit('instances', this.listInstances());
  }
  detachAll() { this.#live.clear(); this.emit('instances', this.listInstances()); }

  onKeys(keys) {
    this.#lastKeys = keys || {};
    for (const inst of this.#instances) this.#processInstance(inst, this.#lastKeys);
  }

  #processInstance(inst, keys) {
    const live = this.#live.get(inst.id);
    const def = this.#defs.get(inst.widgetId);
    if (!live || !def || !def.ok || !inst.systemId) return;
    const { state: st, connections, perConn } = deriveState(keys, inst, def.model);
    reconcilePending(st, live.pending, perConn);
    const peers = this.#peersFor(inst, def.model, keys);
    const changed =
      connections !== live.connections ||
      JSON.stringify(st) !== JSON.stringify(live.state) ||
      JSON.stringify(perConn) !== JSON.stringify(live.perConn || {}) ||
      JSON.stringify(peers) !== JSON.stringify(live.peers || []);
    live.state = st; live.connections = connections; live.perConn = perConn; live.peers = peers;
    const actions = computeActions(def.model, st, live.pending, perConn);
    for (const a of actions) {
      if (a.connId) {
        live.pending[a.connId + '|' + a.property] = String(a.value);
        this.#putConn(inst, def.model, a.property, a.value, a.connId).catch((e) => this.#log('error', `Reply put failed: ${e.message || e}`));
        this.#log('info', `⚙ ${inst.name}: ${a.property} → "${a.value}" (reply on ${a.connId}).`);
        continue;
      }
      this.#put(inst, def.model, a.property, a.value).catch((e) => this.#log('error', `Auto-actualize failed: ${e.message || e}`));
      this.#log('info', `⚙ ${inst.name}: ${a.property} → "${a.value}" (rule).`);
    }
    if (changed || actions.length) {
      this.emit('state', { id: inst.id, state: { ...st, ...live.pending }, connections, peers, perConn });
    }
  }

  async #put(inst, model, prop, value) {
    const live = this.#live.get(inst.id);
    if (!live) throw new Error('Widget is not attached (not connected).');
    const r = model.resolve[prop];
    if (!r || !model.writable.includes(prop)) throw new Error(`Property "${prop}" is not writable by this widget.`);
    const cap = live.caps[`${r.role}|${r.profile}`];
    if (!cap) throw new Error(`No live ${r.role} handle for ${r.profile}.`);
    live.pending[prop] = String(value);
    await cap.put(prop, String(value));
  }

  async #putConn(inst, model, prop, value, connId) {
    const live = this.#live.get(inst.id);
    if (!live) throw new Error('Widget is not attached (not connected).');
    const r = model.resolve[prop];
    if (!r || !model.writable.includes(prop)) throw new Error(`Property "${prop}" is not writable by this widget.`);
    if (!(live.peers || []).some((p) => p.connId === connId)) throw new Error('Unknown connection for this widget.');
    const key = `cns/${inst.systemId}/nodes/${inst.nodeId}/contexts/${inst.contextId}/${r.role}/${r.profile}/connections/${connId}/properties/${prop}`;
    await service.putKey(key, String(value));
    live.perConn = { ...(live.perConn || {}), [connId]: { ...((live.perConn || {})[connId] || {}), [prop]: String(value) } };
    this.#log('info', `⇢ ${inst.name}: ${prop} → "${value}" (this connection only).`);
  }

  async putProperty(instanceId, prop, value, connId = null) {
    const inst = this.#instances.find((i) => i.id === instanceId);
    if (!inst) throw new Error('Unknown widget instance.');
    const def = this.#defs.get(inst.widgetId);
    if (!def || !def.ok) throw new Error('Widget definition unavailable.');
    if (connId) await this.#putConn(inst, def.model, prop, value, connId);
    else await this.#put(inst, def.model, prop, value);
    const live = this.#live.get(instanceId);
    this.emit('state', {
      id: instanceId, state: { ...live.state, ...live.pending },
      connections: live.connections, peers: live.peers || [], perConn: live.perConn || {},
    });
  }
})();

// ------------------------------------------------- faceplates as overlays
const overlays = new Map(); // instanceId -> {wrap, iframe, cbs: {state, theme, info}}

function closeFaceplate(id) {
  const o = overlays.get(id);
  if (!o) return;
  o.wrap.remove();
  overlays.delete(id);
}
function openFaceplate(id) {
  const existing = overlays.get(id);
  if (existing) { existing.wrap.classList.add('fp-focus'); setTimeout(() => existing.wrap.classList.remove('fp-focus'), 300); return; }
  if (!manager.getInstance(id)) return;
  const wrap = document.createElement('div');
  wrap.className = 'fp-overlay';
  const iframe = document.createElement('iframe');
  iframe.className = 'fp-frame';
  iframe.src = 'faceplate.html?instance=' + encodeURIComponent(id);
  wrap.appendChild(iframe);
  document.body.appendChild(wrap);
  // tapping the dimmed backdrop closes (the widget keeps running)
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeFaceplate(id); });
  overlays.set(id, { wrap, iframe, cbs: { state: null, theme: null, info: null } });
}

// The faceplate iframe calls these (same-origin) to get its bridge.
window.__fpBridge = (id, win) => {
  const entry = overlays.get(id) || { cbs: {} };
  return {
    instanceId: id,
    load: async () => {
      const inst = manager.getInstance(id);
      if (!inst) return null;
      const model = manager.getModel(inst.widgetId);
      return {
        id: inst.id, name: inst.name, contextName: inst.contextName, widgetId: inst.widgetId,
        title: model ? model.title : inst.widgetId,
        icon: model ? model.icon || '' : '', color: model ? model.color || '' : '',
        view: model ? model.view : [], writable: model ? model.writable : [],
        localOnly: model ? model.writable.filter((p) => model.resolve[p] && !model.resolve[p].propagate) : [],
        hasRules: !!(model && model.behavior.rules.length),
        state: inst.state, connections: inst.connections,
        peers: inst.peers || [], perConn: inst.perConn || {},
        attached: inst.attached, pinned: false,
        theme: readSettings().theme || 'dark',
      };
    },
    action: (property, value, connId) => manager.putProperty(id, property, String(value), connId || null),
    setPinned: async () => false,
    adjustHeight: () => {},
    onState: (cb) => { entry.cbs.state = cb; return () => {}; },
    onTheme: (cb) => { entry.cbs.theme = cb; return () => {}; },
    onInfo: (cb) => { entry.cbs.info = cb; return () => {}; },
  };
};
window.__fpClose = (id) => closeFaceplate(id);

// route manager events to the app page and to open faceplates
manager.on('state', (payload) => {
  bus.emit('wstate', payload);
  const o = overlays.get(payload.id);
  if (o && o.cbs.state) o.cbs.state(payload);
});
manager.on('instances', (list) => {
  bus.emit('winst', list);
  for (const [id, o] of overlays) {
    const inst = list.find((i) => i.id === id);
    if (!inst) { closeFaceplate(id); continue; }
    if (o.cbs.info) o.cbs.info({ id, name: inst.name, contextName: inst.contextName });
    if (o.iframe.contentDocument) o.iframe.contentDocument.title = inst.name;
  }
});
manager.on('defs', (defs) => bus.emit('wdefs', defs));

// ------------------------------------------------------------- the bridge
window.arete = {
  async getDefaults() {
    const s = readSettings();
    const urlHost = new URLSearchParams(location.search).get('host');
    return {
      protocol: s.protocol || 'wss:',
      host: urlHost || s.host || '',
      port: s.port || 443,
      username: s.username || '',
      password: s.rememberPassword ? (s.password || '') : '',
      allowSelfSigned: false,
      rememberPassword: !!s.rememberPassword,
      autoConnect: !!s.autoConnect,
      canRememberPassword: true,
      systemName: s.systemName || 'Arete Widget (web)',
      theme: s.theme || 'dark',
      userWidgetsDir: '(not available in the web app — use the online library)',
      libraryUrl: s.libraryUrl ?? LIBRARY_DEFAULT,
      libraryUrlDefault: LIBRARY_DEFAULT,
      appVersion: 'PWA',
    };
  },
  async saveSettings(patch) {
    const next = writeSettings(patch || {});
    if (patch && patch.theme) {
      for (const o of overlays.values()) if (o.cbs.theme) o.cbs.theme(patch.theme);
    }
    return next;
  },
  async setAutoConnect(on) { return writeSettings({ autoConnect: !!on }); },
  async openExternal(url) { window.open(url, '_blank', 'noopener'); },

  async connect(opts) {
    const { protocol = 'wss:', host, port = 443, username = '', password = '', allowSelfSigned, systemName: sysName, rememberPassword, autoConnect } = opts || {};
    if (!host) throw new Error('A host is required to connect.');
    if (client) { manager.detachAll(); client.close(); client = null; }
    if (allowSelfSigned) log('warn', 'Browsers cannot skip certificate validation — the realm must present a valid certificate.');
    if (username || password) log('warn', 'Browsers do not attach Basic credentials to WebSocket connects — connecting without credentials.');
    currentHost = host; lastError = null;
    systemName = (sysName || '').trim() || 'Arete Widget (web)';
    setState('connecting');
    log('info', `Connecting to ${protocol}//${host}:${port} ...`);
    client = new BrowserAreteClient(`${protocol}//${host}${port ? ':' + port : ''}`);
    client.on('update', () => { bus.emit('status', getStatus()); scheduleKeysPush(); });
    client.on('close', () => { log('warn', 'Connection closed by host — retrying in the background.'); setState('disconnected'); });
    client.on('open', () => {
      if (state === 'disconnected' || state === 'error') {
        log('info', 'Connection re-established — re-attaching widgets.');
        setState('connected');
        manager.attachAll().catch(() => {});
      }
    });
    client.on('error', () => {
      lastError = 'Socket error (host unreachable, invalid certificate, or auth required)';
      log('error', lastError); setState('error');
    });
    try { await client.waitForOpen(12000); }
    catch (e) {
      lastError = String(e && e.message ? e.message : e);
      setState('error');
      try { client.close(); } catch (_) {}
      client = null;
      throw new Error(lastError);
    }
    setState('connected');
    await client.command('systems', systemId(), systemName).catch(() => {});
    log('info', `Connected. Registered system "${systemName}".`);
    writeSettings({ host, protocol, port, username, systemName, rememberPassword: !!rememberPassword, autoConnect: !!autoConnect, password: rememberPassword ? password : undefined });
    await manager.attachAll();
    return getStatus();
  },

  async disconnect() {
    manager.detachAll();
    if (client) { try { client.close(); } catch (_) {} client = null; }
    currentHost = '';
    if (keysTimer) { clearTimeout(keysTimer); keysTimer = null; }
    bus.emit('keys', {});
    setState('disconnected');
    log('info', 'Disconnected.');
    return getStatus();
  },

  async getStatus() { return getStatus(); },
  async getKeys() { return getKeys(); },
  async getProfile(name) { return fetchProfile(name); },

  // widgets
  async widgetDefs() { return manager.listDefinitions(); },
  async widgetReload() {
    const s = readSettings();
    manager.setLibraryUrl(s.libraryUrl ?? LIBRARY_DEFAULT);
    return manager.loadDefinitions();
  },
  async libraryInfo() { return manager.libraryInfo(); },
  async widgetInstances() { return manager.listInstances(); },
  async widgetAdd(spec) { return manager.addInstance(spec); },
  async widgetUpdate(spec) { return manager.updateInstance(spec); },
  async widgetRemove(id) { closeFaceplate(id); manager.removeInstance(id); },
  async widgetRemoveAll() { for (const id of [...overlays.keys()]) closeFaceplate(id); return manager.removeAllInstances(); },
  async widgetOpen(id) { openFaceplate(id); },

  onKeys(cb) { bus.on('keys', cb); return () => {}; },
  onLog(cb) { bus.on('log', cb); return () => {}; },
  onStatus(cb) { bus.on('status', cb); return () => {}; },
  onWidgetDefs(cb) { bus.on('wdefs', cb); return () => {}; },
  onWidgetInstances(cb) { bus.on('winst', cb); return () => {}; },
  onWidgetState(cb) { bus.on('wstate', cb); return () => {}; },
};

// initial definition load (async; renderer also triggers reloads)
manager.setLibraryUrl(readSettings().libraryUrl ?? LIBRARY_DEFAULT);
manager.loadDefinitions().catch(() => {});

// --------------------------------------------------------- service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => { try { reg.update(); } catch (_) {} }).catch(() => {});
  });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    if (navigator.serviceWorker.controller) location.reload();
  });
}
