#!/usr/bin/env node
// scripts/test-compose-bridge.mjs — verify the PWA's portable Composer module
// against the LIVE cp.padi.io registry, plus round-trip every bundled widget.
// Pure Node (built-in fetch), no dependencies beyond the repo's own files.
// Run: node scripts/test-compose-bridge.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCheck, composeSimulate, slimProfileIndex, dumpDefinition } from '../compose-bridge.js';
import yaml from '../js-yaml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ' — ' + detail}`);
  ok ? pass++ : fail++;
};

const cache = new Map();
async function fetchProfile(name) {
  if (cache.has(name)) return cache.get(name);
  try {
    const res = await fetch('https://cp.padi.io/profiles/' + encodeURIComponent(name), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const j = res.ok ? await res.json() : null;
    cache.set(name, j);
    return j;
  } catch (_) {
    cache.set(name, null);
    return null;
  }
}

// every bundled widget validates and round-trips to an identical model
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'widgets', 'manifest.json'), 'utf8'));
for (const f of manifest.files) {
  const text = fs.readFileSync(path.join(ROOT, 'widgets', f), 'utf8');
  const v1 = await composeCheck(text, fetchProfile);
  if (!v1.ok) { check(`${f}: validates`, false, v1.errors[0]); continue; }
  const v2 = await composeCheck(v1.yaml, fetchProfile);
  check(`${f}: round-trips to an identical model`, v2.ok && JSON.stringify(v1.model) === JSON.stringify(v2.model));
  check(`${f}: canonical YAML is stable`, v2.yaml === v1.yaml);
}

// gate widget: validates AND simulates (v33 core is really in the PWA now)
{
  const text = fs.readFileSync(path.join(ROOT, 'widgets', 'lease-bulb.yaml'), 'utf8');
  const v = await composeCheck(text, fetchProfile);
  check('lease-bulb model carries the gate clause', v.ok && v.model.behavior.rules[0].gate === 'status');
  let sim = composeSimulate(v.model, { sOut: '1', status: 'Offer', cState: '0' });
  check('simulate: closed gate forces else "0" (stays dark)', sim.state.cState === '0');
  sim = composeSimulate(v.model, { sOut: '1', status: 'Approved', cState: '0' });
  check('simulate: Approved gate lets the switch actualize', sim.state.cState === '1');
  sim = composeSimulate(v.model, { sOut: '1', status: 'Delinquent', cState: '1' });
  check('simulate: Delinquent forces a lit bulb back off', sim.state.cState === '0');
}

// registry index → picker shape
{
  const res = await fetch('https://cp.padi.io/profiles', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const list = res.ok ? await res.json() : null;
  check('GET /profiles returns the registry index', Array.isArray(list) && list.length >= 40);
  const slim = slimProfileIndex(list || []);
  const light = slim.find((p) => p.name === 'padi.light');
  check('slim index keeps flags for the picker', !!(light && light.props && light.props.sOut && light.props.sOut.propagate));
}

// YAML text and definition object are the same document
{
  const obj = { widget: 'local.x', title: 'X', capabilities: [{ profile: 'padi.light', role: 'consumer' }], view: [{ type: 'lamp', bind: 'sOut' }] };
  const a = await composeCheck(obj, fetchProfile);
  const b = await composeCheck(dumpDefinition(obj), fetchProfile);
  check('object draft ≡ YAML draft', a.ok && b.ok && JSON.stringify(a.model) === JSON.stringify(b.model));
}

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
