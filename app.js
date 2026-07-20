// app.js — MAIN window UI. Talks to main ONLY through window.arete (preload).
// Three tabs: Widgets (tile grid + add/edit dialog), Status (state + log), Config.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const els = {
  statusDot: $('statusDot'),
  statePill: $('statePill'),
  appVersion: $('appVersion'),
  realmInd: $('realmInd'),
  realmHost: $('realmHost'),
  themeLight: $('themeLight'),
  statusBadge: $('statusBadge'),
  panelStatus: $('panel-status'),
  log: $('log'),
  s: { state: $('s-state'), open: $('s-open'), version: $('s-version'), system: $('s-system'), attached: $('s-attached'), error: $('s-error') },
  form: $('connectForm'),
  protocol: $('protocol'), host: $('host'), port: $('port'),
  username: $('username'), password: $('password'), systemName: $('systemName'),
  allowSelfSigned: $('allowSelfSigned'), rememberPassword: $('rememberPassword'),
  rememberNote: $('rememberNote'), autoConnect: $('autoConnect'),
  connectBtn: $('connectBtn'), disconnectBtn: $('disconnectBtn'),
  clearLogBtn: $('clearLogBtn'), cpLink: $('cpLink'),
  reloadDefsBtn: $('reloadDefsBtn'), userDirNote: $('userDirNote'),
  libraryUrl: $('libraryUrl'),
  tileGrid: $('tileGrid'),
  systemNameNote: $('systemNameNote'),
  removeAllWrap: $('removeAllWrap'),
  dlgOverlay: $('dlgOverlay'), dlgTitle: $('dlgTitle'), dlgBody: $('dlgBody'),
  dlgFoot: $('dlgFoot'), dlgClose: $('dlgClose'),
};

let keys = {};
let defs = [];
let instances = [];
let connected = false;

// ---- Tabs ----
function activateTab(panelId) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.panel === panelId;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== panelId; });
  if (panelId === 'panel-status') els.statusBadge.hidden = true;
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.panel)));

// ---- Log / status ----
function logLine(entry) {
  const time = new Date(entry.ts || Date.now()).toLocaleTimeString();
  const line = document.createElement('span');
  line.className = 'l';
  line.innerHTML = `<span class="t">[${time}] </span><span class="${entry.level || 'info'}">${esc(entry.message)}</span>`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
  if (els.panelStatus.hidden) els.statusBadge.hidden = false;
}

let lastConnected = null;
function renderStatus(st) {
  if (!st) return;
  const state = st.state || 'disconnected';
  connected = state === 'connected';
  els.statusDot.dataset.state = state;
  els.statePill.textContent = state;
  els.statePill.className = 'state-pill ' +
    (state === 'connected' ? 'ok' : state === 'connecting' ? 'mid' : 'bad');
  // centered realm indicator (Monitor treatment)
  const showRealm = !!st.host && (state === 'connected' || state === 'connecting');
  els.realmInd.hidden = !showRealm;
  if (showRealm) els.realmHost.textContent = st.host;
  els.s.state.textContent = state;
  els.s.open.textContent = st.isOpen ? 'yes' : 'no';
  els.s.version.textContent = st.version || '—';
  els.s.system.textContent = (st.identity && st.identity.system) || '—';
  els.s.error.textContent = st.lastError || '—';
  els.connectBtn.disabled = connected || state === 'connecting';
  els.disconnectBtn.disabled = state === 'disconnected';
  // Only re-render on connectedness TRANSITIONS — status arrives every 2s and
  // a blind re-render would rebuild the open dialog mid-interaction.
  if (connected !== lastConnected) {
    lastConnected = connected;
    renderTiles();
    if (dlg) renderDialog(true); // snapshot/restore preserves everything typed
  }
}

// ---- Realm context picker (broker matches on context ID) ----
// Parse contexts with their names AND their declared capabilities, so the
// Join picker can show only contexts that hold a COMPLEMENTARY role for the
// widget's CP(s) — the only contexts the broker could actually bind in.
function realmContexts() {
  const m = {};
  const nameRe = /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/name$/;
  const capRe = /^cns\/([^/]+)\/nodes\/([^/]+)\/contexts\/([^/]+)\/(provider|consumer)\/([^/]+)\//;
  const decls = {}; // ctxId -> Set("sys|node|role|profile") — distinct declarations
  for (const k in keys) {
    let mm = k.match(nameRe);
    if (mm) {
      const e = m[mm[3]] || (m[mm[3]] = { names: {}, count: 0 });
      e.names[keys[k]] = (e.names[keys[k]] || 0) + 1;
      e.count++;
      continue;
    }
    mm = k.match(capRe);
    if (mm) (decls[mm[3]] || (decls[mm[3]] = new Set())).add(`${mm[1]}|${mm[2]}|${mm[4]}|${mm[5]}`);
  }
  return Object.entries(m)
    .map(([id, e]) => {
      const names = Object.entries(e.names).sort((a, b) => b[1] - a[1]);
      const roles = {}; // "role|profile" -> distinct declaration count
      for (const d of decls[id] || []) {
        const [, , role, profile] = d.split('|');
        roles[`${role}|${profile}`] = (roles[`${role}|${profile}`] || 0) + 1;
      }
      return { id, name: names[0][0], also: names.slice(1).map(([n]) => n), declarations: e.count, roles };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Only the contexts where the broker could bind THIS widget: at least one
// declaration of the opposite role for one of the widget's profiles. When
// editing, the instance's CURRENT context is excluded — staying there is the
// "Keep current context" choice, not a join.
function contextsMatching(d, excludeCtxId) {
  const wanted = ((d && d.capabilities) || []).map((c) => ({
    profile: c.profile,
    partner: c.role === 'provider' ? 'consumer' : 'provider',
  }));
  return realmContexts()
    .filter((c) => c.id !== excludeCtxId)
    .map((c) => {
      const partners = [];
      for (const w of wanted) {
        const n = c.roles[`${w.partner}|${w.profile}`] || 0;
        if (n) partners.push(`${n} ${w.profile} ${w.partner}${n === 1 ? '' : 's'}`);
      }
      return { ...c, partnersText: partners.join(', ') };
    })
    .filter((c) => c.partnersText);
}

// =========================================================================
// The add / edit dialog
// dlg is the ONLY dialog state: null (closed) or
//   { mode: 'create'|'edit', step: 1|2, defId, instId, filter }
// Step 1 = filterable widget picker (create mode only); step 2 = config form.
// =========================================================================
let dlg = null;
let pendingCtxId = null; // context id minted for "New context" — survives re-renders
let lastFilter = '';     // picker filter, remembered across dialog opens (this app session only)

function newCtxId() {
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const a = new Uint8Array(22);
  crypto.getRandomValues(a);
  return [...a].map((b) => B[b % 62]).join('');
}

function openCreateDialog() {
  // Seed with the filter from the previous add, so a run of similar widgets
  // doesn't make you retype "light" each time (reset when the app restarts).
  dlg = { mode: 'create', step: 1, defId: null, instId: null, filter: lastFilter };
  pendingCtxId = null;
  renderDialog();
  const search = els.dlgBody.querySelector('#dlgSearch');
  if (search) search.focus();
}

function openEditDialog(instId) {
  const inst = instances.find((i) => i.id === instId);
  if (!inst) return;
  dlg = { mode: 'edit', step: 2, defId: inst.widgetId, instId, filter: '' };
  pendingCtxId = newCtxId(); // ready in case they pick "New context"
  renderDialog();
}

function closeDialog() {
  dlg = null;
  pendingCtxId = null;
  els.dlgOverlay.hidden = true;
}

function defMatches(d, needle) {
  if (!needle) return true;
  const hay = [d.id, d.title, d.description, ...d.capabilities.flatMap((c) => [c.profile, c.role])]
    .join(' ')
    .toLowerCase();
  return needle.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function renderPickList() {
  const list = els.dlgBody.querySelector('#dlgPickList');
  if (!list || !dlg) return;
  const matching = defs.filter((d) => defMatches(d, dlg.filter));
  list.innerHTML = matching.map((d) => {
    const caps = d.capabilities
      .map((c) => `<span class="cap-chip ${c.role}">${esc(c.role)} of ${esc(c.profile)}</span>`)
      .join(' ');
    const src = d.source
      ? `<span class="chip src ${esc(d.source)}" title="${d.source === 'library' ? 'from the online widget library' : d.source === 'local' ? 'from your local widget folder' : 'shipped with the app'}">${esc(d.source)}</span>`
      : '';
    const badge = src + (d.ok
      ? (d.hasBehavior ? ' <span class="chip auto" title="has auto-actualize rules">auto</span>' : '')
      : ' <span class="chip bad">invalid</span>');
    const err = d.ok ? '' : `<div class="def-error">${esc(d.errors[0] || 'Invalid definition.')}</div>`;
    return `<div class="pick-row ${d.ok ? '' : 'invalid'}" ${d.ok ? `data-pick="${esc(d.id)}" role="button" tabindex="0"` : ''}>
      <span class="pick-icon">${esc(d.icon || '▦')}</span>
      <div class="pick-main">
        <div class="def-title">${esc(d.title)} ${badge}</div>
        <div class="def-desc">${esc(d.description)}</div>
        <div class="def-caps">${caps}</div>
        ${err}
      </div>
    </div>`;
  }).join('') || `<p class="empty">No widget matches “${esc(dlg.filter)}”.</p>`;
}

// Snapshot/restore the config form across re-renders so nothing the user
// typed or selected is ever lost when the dialog legitimately needs rebuilding.
function snapshotForm() {
  if (!dlg || dlg.step !== 2) return null;
  const q = (id) => els.dlgBody.querySelector('#' + id);
  const radio = ['af-ctx-keep', 'af-ctx-new', 'af-ctx-join'].find((r) => q(r) && q(r).checked);
  return {
    name: q('af-name') ? q('af-name').value : null,
    radio,
    ctxName: q('af-ctxname') ? q('af-ctxname').value : null,
    ctxSel: q('af-ctxsel') ? q('af-ctxsel').value : null,
  };
}

function restoreForm(snap) {
  if (!snap || !dlg || dlg.step !== 2) return;
  const q = (id) => els.dlgBody.querySelector('#' + id);
  if (snap.name != null && q('af-name')) q('af-name').value = snap.name;
  if (snap.ctxName != null && q('af-ctxname')) q('af-ctxname').value = snap.ctxName;
  if (snap.radio && q(snap.radio) && !q(snap.radio).disabled) {
    ['af-ctx-keep', 'af-ctx-new', 'af-ctx-join'].forEach((r) => { if (q(r)) q(r).checked = r === snap.radio; });
  }
  const sel = q('af-ctxsel');
  if (sel && snap.ctxSel != null && [...sel.options].some((o) => o.value === snap.ctxSel)) {
    sel.value = snap.ctxSel;
  }
  syncFormRows();
}

function renderDialog(preserve = false) {
  if (!dlg) return;
  const snap = preserve ? snapshotForm() : null;
  els.dlgOverlay.hidden = false;
  els.dlgFoot.hidden = dlg.step !== 1;

  if (dlg.step === 1) {
    els.dlgTitle.textContent = 'Add a widget';
    els.dlgBody.innerHTML = `
      <label class="dlg-search-row">Find a widget
        <input type="search" id="dlgSearch" placeholder="type to filter — e.g. “light”" autocomplete="off" value="${esc(dlg.filter)}" />
      </label>
      <div id="dlgPickList" class="pick-list"></div>`;
    renderPickList();
    return;
  }

  // ---- step 2: configuration ----
  const d = defs.find((x) => x.id === dlg.defId);
  const inst = dlg.mode === 'edit' ? instances.find((i) => i.id === dlg.instId) : null;
  if (!d || (dlg.mode === 'edit' && !inst)) { closeDialog(); return; }
  els.dlgTitle.textContent = dlg.mode === 'edit' ? 'Edit widget' : 'Add a widget';
  if (dlg.mode === 'create' && !pendingCtxId) pendingCtxId = newCtxId();

  const caps = d.capabilities
    .map((c) => `<span class="cap-chip ${c.role}">${esc(c.role)} of ${esc(c.profile)}</span>`)
    .join(' ');
  const summary = `<div class="dlg-chosen">
    <span class="pick-icon">${esc(d.icon || '▦')}</span>
    <div class="pick-main">
      <div class="def-title">${esc(d.title)}</div>
      <div class="def-caps">${caps}</div>
    </div>
    ${dlg.mode === 'create'
      ? '<button type="button" class="ghost" data-back>Change</button>'
      : '<span class="muted-note" title="A different widget type is a different contract — create a new widget instead.">type is fixed</span>'}
  </div>`;

  const ctxs = contextsMatching(d, inst ? inst.contextId : undefined);
  const opts = ctxs
    .map((c) => `<option value="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)} — ${esc(c.id.slice(0, 8))}… (${esc(c.partnersText)})</option>`)
    .join('');
  const joinDisabled = ctxs.length ? '' : 'disabled';

  const keepChoice = dlg.mode === 'edit'
    ? `<label class="checkbox"><input type="radio" name="af-ctx" id="af-ctx-keep" checked /> <span>Keep current context</span></label>`
    : '';
  const keepInfo = dlg.mode === 'edit'
    ? `<div id="af-ctxinfo-keep" class="ctx-info">Stays in <strong>${esc(inst.contextName)}</strong> <span class="mono">${esc(inst.contextId)}</span> — existing bindings are untouched. You can still rename the context above.</div>`
    : '';

  els.dlgBody.innerHTML = `${summary}
    <label>Name <input type="text" id="af-name" value="${esc(inst ? inst.name : d.title)}" autocomplete="off" /></label>
    <div class="ctx-choice">
      ${keepChoice}
      <label class="checkbox"><input type="radio" name="af-ctx" id="af-ctx-new" ${dlg.mode === 'edit' ? '' : 'checked'} /> <span>New context</span></label>
      <label class="checkbox"><input type="radio" name="af-ctx" id="af-ctx-join" ${joinDisabled} /> <span>Join existing</span></label>
    </div>
    <div id="af-join-hint" class="ctx-info" ${joinDisabled ? '' : 'hidden'}>No context in the realm has a matching partner for this widget${connected ? '' : ' (not connected)'} — create a new context and let a partner join you instead.</div>
    <label id="af-ctxname-row">Context name <input type="text" id="af-ctxname" value="${esc(inst ? inst.contextName : d.title)}" autocomplete="off" /></label>
    ${keepInfo}
    <div id="af-ctxinfo-new" class="ctx-info" ${dlg.mode === 'edit' ? 'hidden' : ''}>Creates a new matching space with id <span class="mono">${esc(pendingCtxId || '')}</span>.
      Nothing else is in it yet — the widget will show <em>awaiting broker</em> until something joins this context.${dlg.mode === 'edit' ? ' The old context registration remains on the realm until cleaned up there.' : ''}</div>
    <label id="af-ctxsel-row" hidden>Context <select id="af-ctxsel">${opts}</select></label>
    <div id="af-ctxinfo-join" class="ctx-info" hidden></div>
    <div class="actions">
      <button type="button" class="primary" id="af-create" ${dlg.mode === 'edit' || connected ? '' : 'disabled'}>${dlg.mode === 'edit' ? 'Save changes' : 'Create widget'}</button>
      <span class="muted-note">${dlg.mode === 'edit'
        ? (connected ? 'Applies immediately on the realm.' : 'Saved locally — applies when you reconnect.')
        : (connected ? 'Registers a Node under this app’s System.' : 'Connect first (Config tab).')}</span>
    </div>`;
  if (snap) restoreForm(snap); else syncFormRows();
}

// Toggle the context rows to match the radio state.
function syncFormRows() {
  const q = (id) => els.dlgBody.querySelector('#' + id);
  const radioNew = q('af-ctx-new');
  if (!radioNew) return;
  const keeping = q('af-ctx-keep') ? q('af-ctx-keep').checked : false;
  const joining = q('af-ctx-join').checked;
  q('af-ctxname-row').hidden = joining;
  if (q('af-ctxinfo-keep')) q('af-ctxinfo-keep').hidden = !keeping;
  q('af-ctxinfo-new').hidden = joining || keeping;
  q('af-ctxsel-row').hidden = !joining;
  q('af-ctxinfo-join').hidden = !joining;
  if (joining) updateJoinInfo();
}

// Update ONLY the context <select> options in place (called on live keys
// updates) — never rebuilds the form, always preserves the current selection.
function refreshCtxOptions() {
  if (!dlg || dlg.step !== 2) return;
  const sel = els.dlgBody.querySelector('#af-ctxsel');
  if (!sel) return;
  const cur = sel.value;
  const d = defs.find((x) => x.id === dlg.defId);
  const inst = dlg.mode === 'edit' ? instances.find((i) => i.id === dlg.instId) : null;
  const html = contextsMatching(d, inst ? inst.contextId : undefined)
    .map((c) => `<option value="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)} — ${esc(c.id.slice(0, 8))}… (${esc(c.partnersText)})</option>`)
    .join('');
  if (sel.dataset.rendered === html) return; // nothing changed — don't touch it
  sel.innerHTML = html;
  sel.dataset.rendered = html;
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  const joinRadio = els.dlgBody.querySelector('#af-ctx-join');
  if (joinRadio) {
    joinRadio.disabled = sel.options.length === 0;
    if (joinRadio.disabled && joinRadio.checked) {
      // The last matching context vanished mid-form — fall back.
      joinRadio.checked = false;
      const fallback = els.dlgBody.querySelector('#af-ctx-keep') || els.dlgBody.querySelector('#af-ctx-new');
      fallback.checked = true;
      syncFormRows();
    }
  }
  const hint = els.dlgBody.querySelector('#af-join-hint');
  if (hint) hint.hidden = sel.options.length > 0;
  updateJoinInfo(); // the described context may have gained declarations/names
}

// Describe the currently selected existing context: full id, how many
// declarations already live there, and the other names systems use for it.
function updateJoinInfo() {
  const sel = els.dlgBody.querySelector('#af-ctxsel');
  const info = els.dlgBody.querySelector('#af-ctxinfo-join');
  if (!sel || !info || !dlg) return;
  const d = defs.find((x) => x.id === dlg.defId);
  const inst = dlg.mode === 'edit' ? instances.find((i) => i.id === dlg.instId) : null;
  const c = contextsMatching(d, inst ? inst.contextId : undefined).find((x) => x.id === sel.value);
  if (!c) { info.textContent = ''; return; }
  const also = c.also.length ? ` · also known as: ${c.also.map(esc).join(', ')}` : '';
  info.innerHTML = `Joins <strong>${esc(c.name)}</strong> <span class="mono">${esc(c.id)}</span> —
    already holds ${esc(c.partnersText)}, so the broker should bind your widget on arrival.
    Your system adopts the name “${esc(c.name)}”.${also}`;
}

async function submitDialog() {
  if (!dlg || dlg.step !== 2) return;
  const q = (id) => els.dlgBody.querySelector('#' + id);
  const name = q('af-name').value.trim();
  if (!name) return;
  const btn = q('af-create');

  const spec = { name };
  const keeping = q('af-ctx-keep') && q('af-ctx-keep').checked;
  if (q('af-ctx-join').checked) {
    const sel = q('af-ctxsel');
    const opt = sel.options[sel.selectedIndex];
    if (!opt) return;
    spec.contextId = opt.value;
    spec.contextName = opt.dataset.name || name; // adopt the existing name
  } else if (keeping) {
    const inst = instances.find((i) => i.id === dlg.instId);
    spec.contextId = inst.contextId;
    spec.contextName = q('af-ctxname').value.trim() || inst.contextName;
  } else {
    spec.contextId = pendingCtxId || undefined; // exactly the id shown
    spec.contextName = q('af-ctxname').value.trim() || name;
  }

  btn.disabled = true;
  try {
    if (dlg.mode === 'edit') {
      spec.id = dlg.instId;
      await window.arete.widgetUpdate(spec);
      closeDialog();
    } else {
      spec.widgetId = dlg.defId;
      const inst = await window.arete.widgetAdd(spec);
      closeDialog();
      if (inst) window.arete.widgetOpen(inst.id);
    }
  } catch (err) {
    logLine({ level: 'error', message: String(err.message || err) });
    if (els.dlgBody.contains(btn)) btn.disabled = false;
  }
}

// ---- dialog events (delegated on stable containers) ----
els.dlgClose.addEventListener('click', closeDialog);
els.dlgOverlay.addEventListener('click', (e) => { if (e.target === els.dlgOverlay) closeDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dlg) closeDialog(); });

els.dlgBody.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  if (pick && dlg && dlg.step === 1) {
    dlg.defId = pick.dataset.pick;
    dlg.step = 2;
    pendingCtxId = newCtxId();
    renderDialog();
    return;
  }
  if (e.target.closest('[data-back]') && dlg && dlg.mode === 'create') {
    dlg.step = 1;
    pendingCtxId = null;
    renderDialog();
    const search = els.dlgBody.querySelector('#dlgSearch');
    if (search) search.focus();
    return;
  }
  if (e.target.closest('#af-create')) submitDialog();
});
els.dlgBody.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest('[data-pick]')) e.target.closest('[data-pick]').click();
});
els.dlgBody.addEventListener('input', (e) => {
  if (e.target.id === 'dlgSearch' && dlg) {
    dlg.filter = e.target.value;
    lastFilter = e.target.value; // remember for the next add this session
    renderPickList(); // ONLY the list — the input keeps focus and its value
  }
});
els.dlgBody.addEventListener('change', (e) => {
  const id = e.target && e.target.id;
  if (id === 'af-ctx-new' || id === 'af-ctx-join' || id === 'af-ctx-keep') syncFormRows();
  else if (id === 'af-ctxsel') updateJoinInfo();
});

// =========================================================================
// The tile grid — the home page. One tile per widget + a big “+”.
// Tiles hold no typed user state, so re-rendering is always safe: the ⋯ menu
// and armed-remove states are part of the render.
// =========================================================================
let menuFor = null;     // instance id whose ⋯ menu is open
let removeArmed = null; // instance id armed for removal
let removeAllArmed = false; // header "Remove all" confirm showing

// The header "Remove all…" control: hidden with no widgets; armed shows an
// are-you-sure popover (same look as the tile remove confirm).
function renderRemoveAll() {
  const w = els.removeAllWrap;
  if (!w) return;
  if (!instances.length) { removeAllArmed = false; w.innerHTML = ''; return; }
  w.innerHTML = removeAllArmed
    ? `<button type="button" class="danger" data-ra-arm>Remove all…</button>
       <div class="tile-menu confirm" data-ra-panel>
        <div class="menu-q">Remove all ${instances.length} widget${instances.length === 1 ? '' : 's'}?</div>
        <div class="menu-note">Removes every widget from this app and closes their faceplates. The realm nodes are left as-is.</div>
        <div class="menu-row">
          <button type="button" data-ra-cancel>Cancel</button>
          <button type="button" class="danger" data-ra-yes>Remove all</button>
        </div>
      </div>`
    : `<button type="button" class="danger" data-ra-arm title="Remove every widget from this app">Remove all…</button>`;
}

function renderTiles() {
  els.s.attached.textContent = `${instances.filter((i) => i.attached).length} / ${instances.length}`;
  const tiles = instances.map((i) => {
    const def = defs.find((d) => d.id === i.widgetId);
    const icon = def && def.icon ? def.icon : '▦';
    const accent = def && def.color ? ` style="--tile-accent:${esc(def.color)}"` : '';
    const chip = !i.attached
      ? '<span class="chip off">offline</span>'
      : i.connections > 0
        ? `<span class="chip ok">bound · ${i.connections}</span>`
        : '<span class="chip wait">awaiting broker</span>';
    const stateBits = Object.entries(i.state || {}).slice(0, 3)
      .map(([k, v]) => `<span class="kv"><span class="k">${esc(k)}</span>=<span class="v">${esc(v)}</span></span>`)
      .join(' ');
    const peerNames = [...new Set((i.peers || []).map((p) => p.node))];
    const peerBit = peerNames.length
      ? `<div class="tile-peers">⇄ ${esc(peerNames.slice(0, 3).join(', '))}${peerNames.length > 3 ? '…' : ''}</div>`
      : '';
    let menu = '';
    if (menuFor === i.id) {
      menu = removeArmed === i.id
        ? `<div class="tile-menu confirm" data-menu-panel>
            <div class="menu-q">Remove “${esc(i.name)}”?</div>
            <div class="menu-note">Removes it from this app. The realm node is left as-is.</div>
            <div class="menu-row">
              <button type="button" data-remove-cancel>Cancel</button>
              <button type="button" class="danger" data-remove-yes="${esc(i.id)}">Remove</button>
            </div>
          </div>`
        : `<div class="tile-menu" data-menu-panel>
            <button type="button" data-edit="${esc(i.id)}">Edit…</button>
            <button type="button" class="danger" data-remove="${esc(i.id)}">Remove…</button>
          </div>`;
    }
    return `<div class="tile ${menuFor === i.id ? 'menu-open' : ''}" data-open="${esc(i.id)}"${accent} role="button" tabindex="0" title="Open the faceplate">
      <div class="tile-top">
        <span class="tile-icon">${esc(icon)}</span>
        <button type="button" class="ghost tile-more" data-menu="${esc(i.id)}" aria-label="Widget menu" title="Edit or remove">⋯</button>
        ${menu}
      </div>
      <div class="tile-name">${esc(i.name)}</div>
      <div class="tile-sub">${esc(i.widgetTitle)} · ${esc(i.contextName)}</div>
      <div class="tile-chip">${chip}</div>
      <div class="tile-state">${stateBits}</div>
      ${peerBit}
    </div>`;
  }).join('');
  els.tileGrid.innerHTML = tiles + `<button type="button" class="tile plus" data-plus title="Add a widget">
      <span class="plus-sign">+</span><span class="plus-label">Add widget</span>
    </button>`;
  renderRemoveAll();
}

els.removeAllWrap.addEventListener('click', (e) => {
  if (e.target.closest('[data-ra-yes]')) {
    removeAllArmed = false;
    window.arete.widgetRemoveAll(); // 'instances' push re-renders the grid
    return;
  }
  if (e.target.closest('[data-ra-cancel]')) {
    removeAllArmed = false;
    renderRemoveAll();
    return;
  }
  if (e.target.closest('[data-ra-arm]')) {
    removeAllArmed = !removeAllArmed;
    renderRemoveAll();
  }
});

els.tileGrid.addEventListener('click', (e) => {
  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) {
    menuFor = menuFor === menuBtn.dataset.menu ? null : menuBtn.dataset.menu;
    removeArmed = null;
    renderTiles();
    return;
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    menuFor = null;
    renderTiles();
    openEditDialog(edit.dataset.edit);
    return;
  }
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    removeArmed = rm.dataset.remove; // show the confirm view inside the menu
    renderTiles();
    return;
  }
  if (e.target.closest('[data-remove-cancel]')) {
    removeArmed = null; // back to the Edit / Remove menu
    renderTiles();
    return;
  }
  const yes = e.target.closest('[data-remove-yes]');
  if (yes) {
    const id = yes.dataset.removeYes;
    removeArmed = null;
    menuFor = null;
    window.arete.widgetRemove(id);
    return;
  }
  if (e.target.closest('[data-plus]')) {
    openCreateDialog();
    return;
  }
  const tile = e.target.closest('.tile[data-open]');
  if (tile) window.arete.widgetOpen(tile.dataset.open);
});
els.tileGrid.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.tile[data-open]')) {
    window.arete.widgetOpen(e.target.dataset.open);
  }
});
// Any click outside the open ⋯ menu closes it.
document.addEventListener('click', (e) => {
  if (menuFor && !e.target.closest('[data-menu],[data-menu-panel]')) {
    menuFor = null;
    removeArmed = null;
    renderTiles();
  }
});

// ---- Connect ----
async function doConnect(auto) {
  els.connectBtn.disabled = true;
  const opts = {
    protocol: els.protocol.value,
    host: els.host.value.trim(),
    port: Number(els.port.value),
    username: els.username.value.trim(),
    password: els.password.value,
    allowSelfSigned: els.allowSelfSigned.checked,
    systemName: els.systemName.value.trim(),
    rememberPassword: els.rememberPassword.checked,
    autoConnect: els.autoConnect.checked,
  };
  try {
    await window.arete.connect(opts);
    activateTab('panel-widgets');
  } catch (err) {
    logLine({ level: 'error', message: String(err.message || err) });
    els.connectBtn.disabled = false;
    if (auto) activateTab('panel-config');
  }
}

// The "change" link on the system-name note jumps to Config and focuses the field.
els.systemNameNote.addEventListener('click', (e) => {
  if (e.target.closest('#changeSystemName')) {
    e.preventDefault();
    activateTab('panel-config');
    els.systemName.focus();
    els.systemName.select();
  }
});
// Keep the note in sync as the field is edited (so it reflects what will register).
els.systemName.addEventListener('input', () => {
  const name = els.systemName.value.trim() || els.systemName.placeholder || 'Arete Widget';
  els.systemNameNote.innerHTML = `nodes register under “${esc(name)}” · <a href="#" id="changeSystemName">change</a>`;
});

els.form.addEventListener('submit', (e) => { e.preventDefault(); doConnect(false); });
els.disconnectBtn.addEventListener('click', () => window.arete.disconnect());
els.clearLogBtn.addEventListener('click', () => (els.log.innerHTML = ''));
els.cpLink.addEventListener('click', (e) => { e.preventDefault(); window.arete.openExternal(els.cpLink.dataset.url); });
els.reloadDefsBtn.addEventListener('click', async () => {
  els.reloadDefsBtn.disabled = true;
  try {
    await window.arete.widgetReload(); // rescans folders AND refreshes the online library
  } finally {
    els.reloadDefsBtn.disabled = false;
    updateLibraryNote();
  }
});

let userDirCache = '';
async function updateLibraryNote(userDir) {
  if (userDir) userDirCache = userDir;
  try {
    const li = await window.arete.libraryInfo();
    const fresh = li.updatedAt ? ` · refreshed ${new Date(li.updatedAt).toLocaleString()}` : ' · not fetched yet';
    const lib = li.url ? `Online library: ${li.url} (${li.count} widgets${fresh})` : 'Online library: off';
    els.userDirNote.textContent = `${lib} — your local folder: ${userDirCache}`;
  } catch (_) {
    els.userDirNote.textContent = `Your widget folder: ${userDirCache}`;
  }
}

els.libraryUrl.addEventListener('change', () => {
  window.arete.saveSettings({ libraryUrl: els.libraryUrl.value.trim() });
});
els.autoConnect.addEventListener('change', () => window.arete.setAutoConnect(els.autoConnect.checked));
els.themeLight.addEventListener('change', () => {
  const light = els.themeLight.checked;
  document.body.classList.toggle('light', light);
  window.arete.saveSettings({ theme: light ? 'light' : 'dark' });
});

// ---- Init ----
async function init() {
  const d = await window.arete.getDefaults();
  els.protocol.value = d.protocol;
  els.host.value = d.host;
  els.port.value = d.port;
  els.username.value = d.username;
  els.password.value = d.password;
  els.systemName.value = d.systemName;
  els.allowSelfSigned.checked = !!d.allowSelfSigned;
  els.rememberPassword.checked = !!d.rememberPassword;
  els.autoConnect.checked = !!d.autoConnect;
  if (!d.canRememberPassword) {
    els.rememberPassword.disabled = true;
    els.rememberNote.textContent = '(no OS keychain available)';
  }
  const light = d.theme === 'light';
  document.body.classList.toggle('light', light);
  els.themeLight.checked = light;
  if (d.appVersion) els.appVersion.textContent = `v${d.appVersion}`;
  els.systemNameNote.innerHTML = `nodes register under “${esc(d.systemName)}” · <a href="#" id="changeSystemName">change</a>`;
  els.libraryUrl.value = d.libraryUrl;
  els.libraryUrl.placeholder = d.libraryUrlDefault;
  updateLibraryNote(d.userWidgetsDir);

  window.arete.onLog(logLine);
  window.arete.onStatus(renderStatus);
  window.arete.onKeys((k) => { keys = k || {}; refreshCtxOptions(); });
  window.arete.onWidgetDefs((list) => {
    defs = list || [];
    renderTiles(); // tile icons/colors come from the defs
    if (dlg && dlg.step === 1) renderPickList();
  });
  window.arete.onWidgetInstances((list) => { instances = list || []; renderTiles(); });
  window.arete.onWidgetState(({ id, state, connections, peers }) => {
    const i = instances.find((x) => x.id === id);
    if (i) { i.state = state; i.connections = connections; if (peers) i.peers = peers; renderTiles(); }
  });

  defs = await window.arete.widgetDefs();
  instances = await window.arete.widgetInstances();
  keys = await window.arete.getKeys();
  renderTiles();
  renderStatus(await window.arete.getStatus());
  logLine({ level: 'info', message: 'Ready.' });

  if (d.autoConnect && d.host) {
    logLine({ level: 'info', message: 'Auto-connecting…' });
    doConnect(true);
  } else if (!d.host) {
    activateTab('panel-config');
  }
}

init().catch((e) => logLine({ level: 'error', message: 'Init failed: ' + e }));
