// compose.js — the COMPOSE tab: a visual canvas over the widget YAML spec.
// Phase 1 of the Widget Composer (see widget-composer-design.md).
//
// The load-bearing invariant: EVERY CANVAS IS A WIDGET YAML DOCUMENT. The
// Composer edits a plain definition object (the same shape yaml.load gives),
// validation and serialization run in main over the SAME core/widget-spec.js
// the runtime uses, and the preview is faceplate.js itself running in an
// iframe against mock state (compose-fp-bridge.js) — the canvas cannot drift
// from what the app would actually run.
//
// Phase 1 scope: identity, capabilities (typed CP + role, registry-validated),
// visual palette + reorderable stack, per-primitive inspector, mock state,
// YAML round-trip (import/export/apply), draft store, save-as-local-widget.
// Rules are displayed (read-only sentences) and PRESERVED verbatim on
// round-trip — the rule builder is Phase 3. Unknown rule clauses (e.g. a
// future gate/is/else) survive untouched.

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const PRIMS = ['lamp', 'toggle', 'value', 'label', 'field', 'meter', 'options', 'image', 'date', 'stepper', 'split', 'rtt'];
  const LS_DRAFTS = 'composeDrafts.v1';
  const LS_CURRENT = 'composeCurrent.v1';

  const ui = {
    sel: $('cmpDraftSel'), status: $('cmpStatus'),
    newBtn: $('cmpNew'), dupBtn: $('cmpDup'), openBtn: $('cmpOpenDef'), delBtn: $('cmpDelete'),
    exportBtn: $('cmpExport'), saveBtn: $('cmpSave'),
    palette: $('cmpPalette'), viewList: $('cmpViewList'),
    preview: $('cmpPreview'), previewNote: $('cmpPreviewNote'), errors: $('cmpErrors'),
    yaml: $('cmpYaml'), yamlApply: $('cmpYamlApply'),
    identity: $('cmpIdentity'), caps: $('cmpCaps'), inspector: $('cmpInspector'),
    rules: $('cmpRules'), rulesNote: $('cmpRulesNote'), mock: $('cmpMock'),
  };
  if (!ui.sel) return; // panel not present
  if (!window.arete || !window.arete.composeCheck) {
    ui.status.textContent = 'restart the app to enable Compose (main process is older than this UI)';
    ui.status.className = 'cmp-status bad';
    return;
  }

  // ------------------------------------------------------------ draft store
  let drafts = [];
  let cur = null;         // current draft: {key, name, def, mock, updatedAt}
  let selIdx = -1;        // selected view item index
  let check = null;       // last compose:check result
  let appDefs = [];       // window.arete.widgetDefs() cache (collision checks)
  let fpHtml = null;      // faceplate.html source (cached)
  let bridge = null;      // preview bridge for the CURRENT iframe

  const uid = () => Math.random().toString(36).slice(2, 10);

  function loadDrafts() {
    try {
      const j = JSON.parse(localStorage.getItem(LS_DRAFTS));
      if (Array.isArray(j) && j.length) drafts = j.filter((d) => d && d.def);
    } catch (_) {}
    if (!drafts.length) drafts = [newDraftObj()];
    const wanted = localStorage.getItem(LS_CURRENT);
    cur = drafts.find((d) => d.key === wanted) || drafts[0];
  }
  function persist() {
    cur.updatedAt = Date.now();
    try {
      localStorage.setItem(LS_DRAFTS, JSON.stringify(drafts));
      localStorage.setItem(LS_CURRENT, cur.key);
    } catch (_) {}
  }
  function newDraftObj(def, name) {
    let n = 1;
    const ids = new Set(drafts.map((d) => d.def.widget));
    while (ids.has('local.widget-' + n)) n++;
    return {
      key: uid(),
      name: name || '',
      def: def || {
        widget: 'local.widget-' + n,
        title: 'My widget',
        description: '',
        meta: { composed: true, created: new Date().toISOString().slice(0, 10) },
        capabilities: [],
        view: [{ type: 'label', text: 'New widget' }],
      },
      mock: {},
      updatedAt: Date.now(),
    };
  }

  // --------------------------------------------------------------- pipeline
  let checkTimer = null;
  function touched(structural = true) {
    persist();
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => refresh(structural), 350);
  }

  async function refresh(rebuildPreview = true) {
    check = await window.arete.composeCheck(cur.def);
    renderStatus();
    renderYaml();
    renderCaps();      // needs check.caps (prop tables)
    renderViewList();  // bind labels may change validity
    renderInspector();
    renderRules();
    renderMock();
    renderIdentityWarnings();
    if (rebuildPreview) await buildPreview();
  }

  function renderStatus() {
    if (!check) return;
    if (check.ok) {
      ui.status.textContent = '✓ valid widget';
      ui.status.className = 'cmp-status ok';
      ui.saveBtn.disabled = false;
    } else {
      ui.status.textContent = check.errors.length + ' issue' + (check.errors.length === 1 ? '' : 's');
      ui.status.className = 'cmp-status bad';
      ui.saveBtn.disabled = true;
    }
    ui.errors.hidden = check.ok;
    if (!check.ok) ui.errors.textContent = check.errors.map((e) => '• ' + e).join('\n');
  }

  // ------------------------------------------------------------- draft bar
  function renderDraftBar() {
    ui.sel.innerHTML = '';
    for (const d of drafts) {
      const label = (d.def.widget || 'untitled') + (d.def.title ? ' — ' + d.def.title : '') + (d.name ? ` (${d.name})` : '');
      const o = new Option(label, d.key, false, d === cur);
      ui.sel.appendChild(o);
    }
  }
  ui.sel.addEventListener('change', () => {
    cur = drafts.find((d) => d.key === ui.sel.value) || cur;
    selIdx = -1;
    persist();
    renderAll();
  });
  ui.newBtn.addEventListener('click', () => {
    cur = newDraftObj();
    drafts.push(cur);
    selIdx = -1;
    persist();
    renderAll();
  });
  ui.dupBtn.addEventListener('click', () => {
    const copy = JSON.parse(JSON.stringify(cur.def));
    copy.widget = (copy.widget || 'local.widget') + '-copy';
    const d = newDraftObj(copy);
    d.mock = { ...cur.mock };
    drafts.push(d);
    cur = d;
    selIdx = -1;
    persist();
    renderAll();
  });
  ui.delBtn.addEventListener('click', () => {
    if (drafts.length === 1) {
      drafts = [newDraftObj()];
    } else {
      drafts = drafts.filter((d) => d !== cur);
    }
    cur = drafts[0];
    selIdx = -1;
    persist();
    renderAll();
  });

  // "Open widget…": choose any existing definition (bundled/library/local)
  // and put its ACTUAL FILE CONTENT on the canvas — invariant made visible.
  ui.openBtn.addEventListener('click', async () => {
    appDefs = await window.arete.widgetDefs();
    const old = ui.openBtn.nextElementSibling;
    if (old && old.classList.contains('cmp-opensel')) old.remove();
    const sel = document.createElement('select');
    sel.className = 'cmp-opensel';
    sel.appendChild(new Option('Choose a widget…', ''));
    for (const src of ['local', 'library', 'bundled']) {
      const group = document.createElement('optgroup');
      group.label = src;
      for (const d of appDefs.filter((x) => x.source === src)) {
        group.appendChild(new Option(`${d.id} — ${d.title}`, d.id));
      }
      if (group.children.length) sel.appendChild(group);
    }
    ui.openBtn.after(sel);
    sel.focus();
    const done = () => sel.remove();
    sel.addEventListener('blur', () => setTimeout(done, 150));
    sel.addEventListener('change', async () => {
      const id = sel.value;
      done();
      if (!id) return;
      const res = await window.arete.composeReadDef(id);
      if (!res) return;
      const parsed = await window.arete.composeCheck(res.text);
      if (!parsed.raw) {
        ui.status.textContent = 'could not parse ' + id;
        ui.status.className = 'cmp-status bad';
        return;
      }
      const d = newDraftObj(parsed.raw, 'from ' + res.source);
      drafts.push(d);
      cur = d;
      selIdx = -1;
      persist();
      renderAll();
    });
  });

  // Export the canonical YAML as a file download.
  ui.exportBtn.addEventListener('click', () => {
    const text = (check && check.yaml) || '';
    if (!text) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
    a.download = (cur.def.widget || 'widget') + '.yaml';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // Save as a LOCAL widget (userData/widgets). Shadowing a bundled/library id
  // is refused by main; an existing local id asks before overwriting.
  ui.saveBtn.addEventListener('click', async () => {
    if (!check || !check.ok) return;
    let res = await window.arete.composeSaveLocal({ yamlText: check.yaml });
    if (res.exists) {
      if (!confirm(`Local widget "${cur.def.widget}" already exists. Overwrite it?`)) return;
      res = await window.arete.composeSaveLocal({ yamlText: check.yaml, overwrite: true });
    }
    if (res.ok) {
      ui.status.textContent = `saved — "${cur.def.widget}" is now in the Add dialog (local)`;
      ui.status.className = 'cmp-status ok';
    } else {
      ui.status.textContent = res.error || (res.errors && res.errors[0]) || 'save failed';
      ui.status.className = 'cmp-status bad';
    }
  });

  // ---------------------------------------------------------------- identity
  function renderIdentity() {
    const d = cur.def;
    ui.identity.innerHTML = `
      <label>Widget id <span class="muted-note">(slug — becomes the definition id)</span>
        <input id="cmpFid" type="text" value="${esc(d.widget || '')}" spellcheck="false" />
      </label>
      <div class="cmp-idnote" id="cmpIdNote"></div>
      <label>Title <input id="cmpFtitle" type="text" value="${esc(d.title || '')}" /></label>
      <div class="cmp-idrow">
        <label>Description <input id="cmpFdesc" type="text" value="${esc(d.description || '')}" /></label>
        <label>Icon <input id="cmpFicon" type="text" value="${esc(d.icon || '')}" placeholder="💡" /></label>
        <label>Color <input id="cmpFcolor" type="text" value="${esc(d.color || '')}" placeholder="#4c8bf5" /></label>
      </div>
      <label>Author <input id="cmpFauthor" type="text" value="${esc((d.meta && d.meta.author) || '')}" /></label>`;
    const bind = (id, fn) => $(id).addEventListener('input', (e) => { fn(e.target.value); touched(); });
    bind('cmpFid', (v) => { cur.def.widget = v.trim(); renderDraftBar(); });
    bind('cmpFtitle', (v) => { cur.def.title = v; renderDraftBar(); });
    bind('cmpFdesc', (v) => { cur.def.description = v; });
    bind('cmpFicon', (v) => { v.trim() ? cur.def.icon = v.trim() : delete cur.def.icon; });
    bind('cmpFcolor', (v) => { v.trim() ? cur.def.color = v.trim() : delete cur.def.color; });
    bind('cmpFauthor', (v) => {
      cur.def.meta = cur.def.meta || { composed: true };
      v.trim() ? cur.def.meta.author = v.trim() : delete cur.def.meta.author;
    });
  }

  async function renderIdentityWarnings() {
    const note = $('cmpIdNote');
    if (!note) return;
    appDefs = await window.arete.widgetDefs();
    const id = (cur.def.widget || '').trim();
    const hit = appDefs.find((x) => x.id === id);
    if (hit && hit.source !== 'local') {
      note.innerHTML = `<span class="cmp-err">id "${esc(id)}" already exists in the ${hit.source} source — saving is blocked (a local copy would shadow it).</span>`;
    } else if (hit) {
      note.innerHTML = `<span class="cmp-warn">id "${esc(id)}" is an existing LOCAL widget — saving will overwrite it.</span>`;
    } else {
      note.innerHTML = '';
    }
  }

  // ---------------------------------------------------- CP registry picker
  // Phase 2: browse/search cp.padi.io instead of typing CP names. One index
  // fetch (main caches it and seeds the per-profile cache) powers search,
  // the property/flag preview, and role choice.
  let pickerOpen = false;
  let pickerIndex = null; // [{name,title,comment,company,modified,props}]
  let pickerError = '';
  let pickerFilter = '';
  let pickerSel = null;   // expanded profile name

  async function loadPickerIndex(refresh) {
    const res = await window.arete.composeProfileIndex(!!refresh);
    pickerIndex = res.profiles || [];
    pickerError = res.ok ? '' : (res.error || 'registry unreachable');
  }

  function pickerPropTable(props) {
    const names = Object.keys(props || {});
    if (!names.length) return '<span class="muted-note">no properties published</span>';
    return names.map((n) => {
      const p = props[n];
      return `<span class="pn">${esc(n)}</span>` +
        `<span class="cmp-flag">${p.writer === 'server' ? 'provider writes' : 'consumer writes'}</span>` +
        (p.propagate ? '<span class="cmp-flag">propagate</span>' : '<span class="cmp-flag" title="not broadcast — crosses per-connection (addressed channel)">addressed</span>') +
        (p.required ? '<span class="cmp-flag">required</span>' : '') +
        (p.desc ? ` <span class="muted-note">${esc(p.desc)}</span>` : '');
    }).join('<br/>');
  }

  function renderPicker(host) {
    const box = document.createElement('div');
    box.className = 'cmp-picker';
    if (pickerIndex === null) {
      box.innerHTML = '<p class="muted-note">loading the CP registry…</p>';
      host.appendChild(box);
      return;
    }
    const q = pickerFilter.trim().toLowerCase();
    const hits = pickerIndex
      .filter((p) => !q || [p.name, p.title, p.comment, p.company].some((x) => (x || '').toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
    box.innerHTML = `
      <div class="cmp-pk-head">
        <input type="text" id="cmpPkSearch" placeholder="search ${pickerIndex.length} connection profiles…" value="${esc(pickerFilter)}" spellcheck="false" />
        <button type="button" class="ghost" id="cmpPkRefresh" title="Re-fetch the registry index (cache-busted)">↻</button>
        <button type="button" class="ghost" id="cmpPkClose" title="Close">✕</button>
      </div>
      ${pickerError ? `<p class="cmp-err">${esc(pickerError)} — showing the cached index.</p>` : ''}
      <div class="cmp-pk-list" id="cmpPkList"></div>`;
    host.appendChild(box);
    const list = box.querySelector('#cmpPkList');
    if (!hits.length) list.innerHTML = '<p class="muted-note">no profile matches — the registry is authoritative: a CP that is not listed cannot be used.</p>';
    for (const p of hits) {
      const row = document.createElement('div');
      row.className = 'cmp-pk-row' + (pickerSel === p.name ? ' on' : '');
      row.innerHTML = `<span class="pn">${esc(p.name)}</span><span class="pt">${esc(p.title)}</span>` +
        `<span class="pc">${p.props ? Object.keys(p.props).length + ' props' : 'no versions'}</span>`;
      row.addEventListener('click', () => {
        pickerSel = pickerSel === p.name ? null : p.name;
        renderCaps();
      });
      list.appendChild(row);
      if (pickerSel === p.name) {
        const prev = document.createElement('div');
        prev.className = 'cmp-pk-prev';
        const dup = (role) => (cur.def.capabilities || []).some((c) => c.profile === p.name && c.role === role);
        prev.innerHTML = `
          ${p.comment ? `<p class="muted-note">${esc(p.comment)}${p.company ? ' · ' + esc(p.company) : ''}</p>` : ''}
          <div class="cmp-cap-props">${pickerPropTable(p.props)}</div>
          <div class="cmp-pk-add">
            <button type="button" class="primary" data-role="consumer" ${!p.props || dup('consumer') ? 'disabled' : ''}>Add as consumer</button>
            <button type="button" class="primary" data-role="provider" ${!p.props || dup('provider') ? 'disabled' : ''}>Add as provider</button>
          </div>`;
        prev.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
          cur.def.capabilities = Array.isArray(cur.def.capabilities) ? cur.def.capabilities : [];
          cur.def.capabilities.push({ profile: p.name, role: b.dataset.role });
          pickerOpen = false;
          pickerSel = null;
          pickerFilter = '';
          touched();
          renderCaps();
        }));
        list.appendChild(prev);
      }
    }
    box.querySelector('#cmpPkSearch').addEventListener('input', (e) => {
      pickerFilter = e.target.value;
      const at = e.target.selectionStart;
      renderCaps();
      const inp = $('cmpPkSearch');
      if (inp) { inp.focus(); inp.setSelectionRange(at, at); }
    });
    box.querySelector('#cmpPkRefresh').addEventListener('click', async () => {
      pickerIndex = null;
      renderCaps();
      await loadPickerIndex(true);
      renderCaps();
    });
    box.querySelector('#cmpPkClose').addEventListener('click', () => {
      pickerOpen = false;
      pickerSel = null;
      renderCaps();
    });
  }

  // ------------------------------------------------------------ capabilities
  function renderCaps() {
    const caps = Array.isArray(cur.def.capabilities) ? cur.def.capabilities : [];
    const info = (check && check.caps) || [];
    ui.caps.innerHTML = '';
    caps.forEach((c, i) => {
      const inf = info[i] || { ok: false, props: {} };
      const box = document.createElement('div');
      box.className = 'cmp-cap';
      const status = !c.profile
        ? '<span class="cmp-cap-status wait">enter a CP name</span>'
        : inf.ok
          ? `<span class="cmp-cap-status ok">✓ ${esc(inf.title || 'in registry')}</span>`
          : '<span class="cmp-cap-status bad">not in the CP registry — refused</span>';
      box.innerHTML = `
        <div class="cmp-cap-head">
          <input type="text" value="${esc(c.profile || '')}" placeholder="padi.light" spellcheck="false" />
          <select>
            <option value="consumer"${c.role === 'consumer' ? ' selected' : ''}>consumer</option>
            <option value="provider"${c.role === 'provider' ? ' selected' : ''}>provider</option>
          </select>
          <button type="button" class="ghost danger" title="Remove capability">✕</button>
        </div>
        <div>${status}</div>
        <div class="cmp-cap-props">${propTable(inf, c.role)}</div>`;
      const [inp] = box.getElementsByTagName('input');
      const [sel] = box.getElementsByTagName('select');
      const del = box.querySelector('button');
      inp.addEventListener('change', () => { c.profile = inp.value.trim(); touched(); });
      sel.addEventListener('change', () => { c.role = sel.value; touched(); });
      del.addEventListener('click', () => { caps.splice(i, 1); touched(); renderCaps(); });
      ui.caps.appendChild(box);
    });
    if (pickerOpen) {
      renderPicker(ui.caps);
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'ghost';
      add.id = 'cmpCapAdd';
      add.textContent = '+ Add capability (browse the registry)';
      add.addEventListener('click', async () => {
        cur.def.capabilities = caps;
        pickerOpen = true;
        renderCaps();
        if (pickerIndex === null) {
          await loadPickerIndex(false);
          renderCaps();
        }
      });
      ui.caps.appendChild(add);
    }
  }

  function propTable(inf, role) {
    const names = Object.keys(inf.props || {});
    if (!names.length) return '';
    return names.map((n) => {
      const p = inf.props[n];
      const writes = (role === 'provider') === (p.writer === 'server');
      return `<span class="pn">${esc(n)}</span>` +
        (writes ? '<span class="cmp-flag w">you write</span>' : '<span class="cmp-flag">peer writes</span>') +
        (p.propagate ? '<span class="cmp-flag">propagate</span>' : '<span class="cmp-flag" title="not broadcast — crosses per-connection (addressed channel)">addressed</span>') +
        (p.required ? '<span class="cmp-flag">required</span>' : '');
    }).join('<br/>');
  }

  // ---------------------------------------------------- palette + view stack
  function renderPalette() {
    ui.palette.innerHTML = '';
    for (const t of PRIMS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t === 'split' ? 'split ⇥' : t;
      b.title = t === 'split' ? 'column break — items after it render in a second column' : 'add a ' + t;
      b.addEventListener('click', () => {
        cur.def.view = Array.isArray(cur.def.view) ? cur.def.view : [];
        cur.def.view.push(defaultPrim(t));
        selIdx = cur.def.view.length - 1;
        touched();
        renderViewList();
        renderInspector();
      });
      ui.palette.appendChild(b);
    }
  }

  function defaultPrim(t) {
    const firstBind = firstBindable(t);
    switch (t) {
      case 'split': return { type: 'split' };
      case 'label': return { type: 'label', text: 'Label' };
      case 'rtt': return { type: 'rtt', send: firstBindable('field') || 'send', echo: firstBind || 'response' };
      case 'meter': return { type: 'meter', bind: firstBind || '', min: 0, max: 5 };
      case 'options': return { type: 'options', bind: firstBind || '', values: ['A', 'B'] };
      case 'stepper': return { type: 'stepper', bind: firstBind || '', step: 1 };
      default: return { type: t, bind: firstBind || '' };
    }
  }

  // All properties visible to this draft (from the checked capability tables),
  // with writability under the declared role.
  function knownProps() {
    const out = [];
    for (const inf of (check && check.caps) || []) {
      for (const n in inf.props || {}) {
        const p = inf.props[n];
        out.push({
          name: n,
          profile: inf.profile,
          writable: (inf.role === 'provider') === (p.writer === 'server'),
        });
      }
    }
    return out;
  }
  function firstBindable(type) {
    const props = knownProps();
    const needW = type === 'toggle' || type === 'field';
    const hit = props.find((p) => (needW ? p.writable : true));
    return hit ? hit.name : '';
  }

  function rowLabel(v) {
    if (v.type === 'split') return '— column break —';
    if (v.type === 'label') return v.text != null ? JSON.stringify(v.text) : (v.bind || '');
    if (v.type === 'rtt') return `${v.send || '?'} → ${v.echo || '?'}`;
    return v.bind || '(unbound)';
  }

  function renderViewList() {
    const view = Array.isArray(cur.def.view) ? cur.def.view : [];
    ui.viewList.innerHTML = '';
    view.forEach((v, i) => {
      const row = document.createElement('div');
      row.className = 'cmp-vrow' + (i === selIdx ? ' sel' : '') + (v.type === 'split' ? ' is-split' : '');
      row.draggable = true;
      row.innerHTML = `<span class="grip" title="drag to reorder">⋮⋮</span>` +
        `<span class="t">${esc(v.type)}</span><span class="b">${esc(rowLabel(v))}</span>` +
        `<span class="rowbtns">` +
        `<button type="button" class="ghost" data-a="up" title="Move up">▲</button>` +
        `<button type="button" class="ghost" data-a="dn" title="Move down">▼</button>` +
        `<button type="button" class="ghost danger" data-a="rm" title="Remove">✕</button></span>`;
      row.addEventListener('click', (e) => {
        const a = e.target.dataset && e.target.dataset.a;
        if (a === 'up' && i > 0) { view.splice(i - 1, 0, view.splice(i, 1)[0]); selIdx = i - 1; touched(); renderViewList(); renderInspector(); return; }
        if (a === 'dn' && i < view.length - 1) { view.splice(i + 1, 0, view.splice(i, 1)[0]); selIdx = i + 1; touched(); renderViewList(); renderInspector(); return; }
        if (a === 'rm') { view.splice(i, 1); if (selIdx >= view.length) selIdx = view.length - 1; touched(); renderViewList(); renderInspector(); return; }
        selIdx = i;
        renderViewList();
        renderInspector();
      });
      row.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(i)));
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('dragover'); });
      row.addEventListener('dragleave', () => row.classList.remove('dragover'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('dragover');
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (!Number.isFinite(from) || from === i) return;
        const [moved] = view.splice(from, 1);
        view.splice(i, 0, moved);
        selIdx = i;
        touched();
        renderViewList();
        renderInspector();
      });
      ui.viewList.appendChild(row);
    });
    if (!view.length) ui.viewList.innerHTML = '<p class="muted-note">Add elements from the palette above.</p>';
  }

  // ------------------------------------------------------------- inspector
  function renderInspector() {
    const view = Array.isArray(cur.def.view) ? cur.def.view : [];
    const v = view[selIdx];
    if (!v) {
      ui.inspector.innerHTML = '<p class="muted-note">Select an element in the Faceplate list.</p>';
      return;
    }
    const props = knownProps();
    const needW = v.type === 'toggle' || v.type === 'field';
    const bindSel = (cu, field, writableOnly) => {
      const opts = props
        .filter((p) => (writableOnly ? p.writable : true))
        .map((p) => `<option value="${esc(p.name)}"${cu === p.name ? ' selected' : ''}>${esc(p.name)} (${esc(p.profile)}${p.writable ? ' · you write' : ''})</option>`)
        .join('');
      const custom = cu && !props.some((p) => p.name === cu)
        ? `<option value="${esc(cu)}" selected>${esc(cu)} (unknown property)</option>` : '';
      return `<label>${field} <select data-f="${field}"><option value="">—</option>${custom}${opts}</select></label>`;
    };
    let html = `<p class="muted-note">${esc(v.type)}</p>`;
    if (v.type !== 'split' && v.type !== 'rtt' && v.type !== 'label') html += bindSel(v.bind || '', 'bind', needW);
    if (v.type === 'label') {
      html += `<label>text <input data-f="text" type="text" value="${esc(v.text ?? '')}" placeholder="static text (clear to use bind)" /></label>`;
      html += bindSel(v.bind || '', 'bind', false);
    }
    if (v.type === 'rtt') {
      html += bindSel(v.send || '', 'send', true);
      html += bindSel(v.echo || '', 'echo', false);
    }
    if (v.type === 'lamp' || v.type === 'toggle') {
      html += `<div class="cmp-idrow"><label>on <input data-f="on" type="text" value="${esc(v.on ?? '1')}" /></label>` +
              `<label>off <input data-f="off" type="text" value="${esc(v.off ?? '0')}" /></label><span></span></div>`;
    }
    if (v.type === 'meter') {
      html += `<div class="cmp-idrow"><label>min <input data-f="min" type="number" value="${esc(v.min ?? 0)}" /></label>` +
              `<label>max <input data-f="max" type="number" value="${esc(v.max ?? 5)}" /></label><span></span></div>`;
    }
    if (v.type === 'stepper') {
      html += `<div class="cmp-idrow"><label>min <input data-f="min" type="number" value="${esc(v.min ?? '')}" /></label>` +
              `<label>max <input data-f="max" type="number" value="${esc(v.max ?? '')}" /></label>` +
              `<label>step <input data-f="step" type="number" value="${esc(v.step ?? 1)}" /></label></div>`;
    }
    if (v.type === 'options') {
      html += `<label>values <span class="muted-note">(comma-separated)</span>` +
              `<input data-f="values" type="text" value="${esc((v.values || []).join(', '))}" /></label>`;
    }
    if (v.type !== 'split') {
      html += `<label>caption <input data-f="caption" type="text" value="${esc(v.caption ?? '')}" /></label>`;
    }
    ui.inspector.innerHTML = html;
    ui.inspector.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
        const f = el.dataset.f;
        const val = el.value;
        if (f === 'values') {
          v.values = val.split(',').map((x) => x.trim()).filter(Boolean);
        } else if (f === 'min' || f === 'max' || f === 'step') {
          val === '' ? delete v[f] : v[f] = Number(val);
        } else if (val === '' && (f === 'caption' || f === 'text' || f === 'bind')) {
          delete v[f];
        } else {
          v[f] = val;
        }
        touched();
        renderViewList();
      });
    });
  }

  // ------------------------------------------------------- rules (read-only)
  function renderRules() {
    const b = cur.def.behavior || {};
    const rules = Array.isArray(b.rules) ? b.rules : [];
    const init = b.init && typeof b.init === 'object' ? b.init : {};
    ui.rulesNote.textContent = rules.length ? `(${rules.length} — editable in a later phase)` : '(none — rule builder lands in Phase 3)';
    let html = '';
    if (Object.keys(init).length) {
      html += `<div class="cmp-rule"><span class="kw">at start</span> set ` +
        Object.entries(init).map(([k, v]) => `<code>${esc(k)}</code> = <code>${esc(v)}</code>`).join(', ') + '</div>';
    }
    const KNOWN = ['when', 'set', 'map', 'aggregate', 'reply', 'gate', 'is', 'else'];
    for (const r of rules) {
      if (!r || typeof r !== 'object') continue;
      let s = `<span class="kw">when</span> <code>${esc(r.when)}</code> changes → <span class="kw">set</span> <code>${esc(r.set)}</code>`;
      if (r.map) s += `, <span class="kw">mapped</span> <code>${esc(Object.entries(r.map).map(([k, v]) => k + '→' + v).join(', '))}</code>`;
      if (r.aggregate) s += `, <span class="kw">aggregated by</span> <code>${esc(r.aggregate)}</code>`;
      if (r.reply) s += `, <span class="kw">replying per connection</span>`;
      if (r.gate) {
        s += `, <span class="kw">gated on</span> <code>${esc(r.gate)}</code> <span class="kw">being</span> <code>${esc(r.is)}</code>`;
        if (r.else !== undefined) s += `, <span class="kw">else</span> <code>${esc(r.else)}</code>`;
      }
      const extra = Object.keys(r).filter((k) => !KNOWN.includes(k));
      if (extra.length) s += ` <span class="cmp-rule-extra">· preserved clauses: ${esc(extra.join(', '))}</span>`;
      html += `<div class="cmp-rule">${s}</div>`;
    }
    ui.rules.innerHTML = html || '<p class="muted-note">This widget has no behavior rules. Rules make a widget act on its own (mirror, map, aggregate…).</p>';
  }

  // ------------------------------------------------------------- mock state
  function boundProps() {
    const set = new Set();
    for (const v of Array.isArray(cur.def.view) ? cur.def.view : []) {
      if (v && v.bind) set.add(v.bind);
      if (v && v.send) set.add(v.send);
      if (v && v.echo) set.add(v.echo);
    }
    const b = cur.def.behavior || {};
    for (const r of Array.isArray(b.rules) ? b.rules : []) {
      if (r && r.when) set.add(r.when);
      if (r && r.set) set.add(r.set);
    }
    return [...set];
  }

  function renderMock() {
    const props = boundProps();
    if (!props.length) {
      ui.mock.innerHTML = '<p class="muted-note">Bind an element to a property and its sample value appears here.</p>';
      return;
    }
    ui.mock.innerHTML = '';
    for (const p of props) {
      const row = document.createElement('div');
      row.className = 'cmp-mockrow';
      row.innerHTML = `<span class="mn">${esc(p)}</span><input type="text" value="${esc(cur.mock[p] ?? '')}" placeholder="sample value" />`;
      row.querySelector('input').addEventListener('input', (e) => {
        const val = e.target.value;
        val === '' ? delete cur.mock[p] : cur.mock[p] = val;
        persist();
        if (bridge) bridge.setState(cur.mock);
      });
      ui.mock.appendChild(row);
    }
  }

  // ------------------------------------------------------------ YAML panel
  function renderYaml() {
    if (document.activeElement === ui.yaml) return; // never clobber an edit in progress
    ui.yaml.value = (check && check.yaml) || '';
  }
  ui.yamlApply.addEventListener('click', async () => {
    const res = await window.arete.composeCheck(ui.yaml.value);
    if (!res.raw) {
      ui.status.textContent = (res.errors && res.errors[0]) || 'YAML parse error';
      ui.status.className = 'cmp-status bad';
      return;
    }
    cur.def = res.raw;
    selIdx = -1;
    persist();
    renderAll();
  });

  // --------------------------------------------------------------- preview
  // The canvas preview IS faceplate.js, running unmodified in an iframe whose
  // window.faceplate is a mock bridge over the draft's model + mock state.
  function makeBridge(model, state) {
    let stateCb = null;
    let themeCb = null;
    const push = () => {
      if (stateCb) stateCb({ state: { ...state }, connections: 0, peers: [], perConn: {}, rtt: {} });
      scheduleChrome();
    };
    const api = {
      load: async () => ({
        id: 'draft',
        name: cur.def.title || cur.def.widget || 'Draft',
        contextName: 'draft canvas',
        widgetId: cur.def.widget || 'draft',
        title: model.title,
        icon: model.icon || '',
        color: model.color || '',
        view: model.view,
        writable: model.writable,
        localOnly: model.writable.filter((p) => model.resolve[p] && !model.resolve[p].propagate),
        bindProfile: Object.fromEntries(Object.entries(model.resolve)
          .filter(([, r]) => r !== 'AMBIGUOUS')
          .map(([prop, r]) => [prop, r.profile])),
        hasRules: !!(model.behavior.rules || []).length,
        state: { ...state },
        connections: 0,
        peers: [],
        perConn: {},
        rtt: {},
        attached: true,
        pinned: false,
        theme: document.body.classList.contains('light') ? 'light' : 'dark',
      }),
      // A control interaction in the preview writes MOCK state, then lets the
      // real behavior engine converge on it (compose:simulate) — so a draft
      // switch flips a draft bulb exactly the way the realm eventually would.
      action: async (prop, value) => {
        state[prop] = String(value);
        cur.mock[prop] = String(value);
        const sim = await window.arete.composeSimulate({ model, state: { ...state } });
        Object.assign(state, sim.state);
        Object.assign(cur.mock, sim.state);
        persist();
        push();
        renderMock();
      },
      onState: (cb) => { stateCb = cb; return () => { stateCb = null; }; },
      onTheme: (cb) => { themeCb = cb; },
      onInfo: () => {},
      setPinned: async (v) => !!v,
    };
    return {
      api,
      push,
      setTheme: (t) => themeCb && themeCb(t),
      setState: (mock) => {
        for (const k of Object.keys(state)) delete state[k];
        Object.assign(state, mock);
        push();
      },
    };
  }

  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  function scheduleChrome() {
    raf(fixChrome);
    setTimeout(fixChrome, 120);
  }
  function fixChrome() {
    try {
      const doc = ui.preview.contentDocument;
      if (!doc) return;
      const chip = doc.getElementById('fpChip');
      if (chip) { chip.className = 'chip wait'; chip.textContent = 'draft · mock'; }
      const pin = doc.getElementById('fpPin');
      const close = doc.getElementById('fpClose');
      if (pin) pin.hidden = true;
      if (close) close.hidden = true;
      // size the frame to its content
      const h = Math.max(260, Math.min(600, doc.body.scrollHeight + 8));
      ui.preview.style.height = h + 'px';
    } catch (_) {}
  }

  async function buildPreview() {
    if (!check || !check.ok || !check.model) {
      ui.preview.srcdoc = '<body style="margin:0;background:transparent"></body>';
      bridge = null;
      return;
    }
    if (!fpHtml) fpHtml = await window.arete.composeFaceplateHtml();
    if (!fpHtml) {
      ui.previewNote.textContent = 'preview unavailable (faceplate.html not readable)';
      return;
    }
    const state = {};
    for (const k in cur.mock) state[k] = String(cur.mock[k]);
    bridge = makeBridge(check.model, state);
    window.__composeBridge = () => bridge.api;
    ui.preview.srcdoc = fpHtml.replace(
      '<script src="faceplate.js">',
      '<script src="compose-fp-bridge.js"></script><script src="faceplate.js">'
    );
    ui.preview.onload = () => { scheduleChrome(); setTimeout(fixChrome, 400); };
  }

  // Theme follows the app live (body.light is toggled by app.js/Config).
  new MutationObserver(() => {
    if (bridge) bridge.setTheme(document.body.classList.contains('light') ? 'light' : 'dark');
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ------------------------------------------------------------------ boot
  function renderAll() {
    renderDraftBar();
    renderIdentity();
    renderPalette();
    renderViewList();
    renderInspector();
    refresh(true);
  }

  loadDrafts();
  renderAll();
})();
