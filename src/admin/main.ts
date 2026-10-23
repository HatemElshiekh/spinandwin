import '../shared/base.css';
import './admin.css';
import { request, rpc, esc, configured, ApiError } from '../shared/api';

interface AuthSession { access_token: string; refresh_token: string; expires_at: number }
interface Entry {
  claim_code: string; type: string; gift_name: string; full_name: string; company: string;
  committed_at: string; collected_at: string | null; collected_by_name: string | null;
}
interface GiftRow { id: string; name: string; total: number; allocation: number; committed: number; reserved: number; collected: number; available: number }
interface Overview {
  now: string; event_day: number; event_days: number; live: boolean; paused: boolean; demo: boolean;
  last_event_at: string | null; last_error: { at: string; session_id: string; message: string } | null;
  gifts: GiftRow[]; counters: Record<string, number>;
}

const app = document.getElementById('app')!;
const who = document.getElementById('who')!;
const STORE = 'gc_spin_admin';
let auth: AuthSession | null = null;
let me: { name: string; role: 'rep' | 'manager' } | null = null;
let tab: 'claim' | 'stock' | 'controls' = 'claim';
let refreshTimer = 0;

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' }) + ' GST' : '');

function load() {
  try { auth = JSON.parse(localStorage.getItem(STORE) ?? 'null'); } catch { auth = null; }
}
function save() {
  try { auth ? localStorage.setItem(STORE, JSON.stringify(auth)) : localStorage.removeItem(STORE); } catch { /* private mode */ }
}

async function signIn(email: string, password: string) {
  auth = await request<AuthSession>('/auth/v1/token?grant_type=password', { email, password });
  save();
}

async function freshToken(): Promise<string> {
  if (!auth) throw new ApiError('signed out', 401);
  if (auth.expires_at * 1000 - Date.now() < 60_000) {
    auth = await request<AuthSession>('/auth/v1/token?grant_type=refresh_token', { refresh_token: auth.refresh_token });
    save();
  }
  return auth.access_token;
}

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await rpc<T>(fn, args, await freshToken());
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.message.includes('JWT'))) signOut();
    throw e;
  }
}

function signOut() {
  auth = null;
  me = null;
  save();
  renderLogin();
}

// Login --------------------------------------------------------------------------------

function renderLogin(msg = '') {
  clearInterval(refreshTimer);
  who.innerHTML = '';
  app.innerHTML = `<section class="panel narrow">
    <h1>Sign in</h1>
    <form id="login">
      <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      ${msg ? `<p class="alert" role="alert">${esc(msg)}</p>` : ''}
      <button class="btn">Sign in</button>
    </form>
  </section>`;
  const f = document.getElementById('login') as HTMLFormElement;
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = f.querySelector('button')!;
    btn.disabled = true;
    try {
      await signIn((f.email as HTMLInputElement).value.trim(), (f.password as HTMLInputElement).value);
      await afterSignIn();
    } catch (e) {
      renderLogin(e instanceof ApiError && e.status === 400 ? 'Email or password is not correct.' : 'Could not sign in. Check the connection and try again.');
    }
  });
}

async function afterSignIn() {
  me = await call('spin_admin_me');
  if (!me) {
    auth = null;
    save();
    return renderLogin('This account is not on the representative list. Ask Hatem to add it.');
  }
  who.innerHTML = `<span>${esc(me.name)} (${me.role === 'manager' ? 'manager' : 'representative'})</span>
    <button class="link-btn" id="out">Sign out</button>`;
  document.getElementById('out')!.addEventListener('click', signOut);
  renderShell();
}

// Shell and tabs -------------------------------------------------------------------------

function renderShell() {
  app.innerHTML = `<nav class="tabs" role="tablist">
      <button role="tab" data-tab="claim">Claim code</button>
      <button role="tab" data-tab="stock">Stock and activity</button>
      <button role="tab" data-tab="controls">Controls and exports</button>
    </nav>
    <div id="view"></div>`;
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => { tab = b.dataset.tab as typeof tab; showTab(); }));
  showTab();
}

function showTab() {
  clearInterval(refreshTimer);
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (tab === 'claim') renderClaim();
  else if (tab === 'stock') { renderStock(); refreshTimer = window.setInterval(renderStock, 15000); }
  else renderControls();
}

const view = () => document.getElementById('view')!;

function errorText(e: unknown) {
  if (e instanceof ApiError && e.message.includes('not_authorized')) return 'Your account is not allowed to do this.';
  return 'Could not reach the server. Try again.';
}

// Claim codes ------------------------------------------------------------------------------

function renderClaim() {
  view().innerHTML = `<section class="panel narrow">
    <h2>Look up a claim code</h2>
    <form id="lookup" class="row">
      <input name="code" class="code-input" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false"
        placeholder="6 characters" aria-label="Claim code" required>
      <button class="btn">Look up</button>
    </form>
    <div id="result" aria-live="polite"></div>
  </section>`;
  const f = document.getElementById('lookup') as HTMLFormElement;
  const input = f.code as HTMLInputElement;
  input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  input.focus();
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = document.getElementById('result')!;
    out.innerHTML = '<p>Checking</p>';
    try {
      const r = await call<{ ok: boolean; error?: string; entry?: Entry }>('spin_admin_lookup', { p_code: input.value });
      if (!r.ok) { out.innerHTML = '<p class="alert">No entry with this code. Check each character with the visitor.</p>'; return; }
      showEntry(r.entry!);
    } catch (e) {
      out.innerHTML = `<p class="alert">${errorText(e)}</p>`;
    }
  });
}

function showEntry(e: Entry, note = '') {
  const out = document.getElementById('result')!;
  const collected = Boolean(e.collected_at);
  out.innerHTML = `<div class="entry ${collected ? 'is-collected' : ''}">
    <p class="status">${collected ? 'Already collected' : 'Not collected yet'}</p>
    <dl>
      <dt>Gift</dt><dd class="big">${esc(e.gift_name)}</dd>
      <dt>Name</dt><dd>${esc(e.full_name)}</dd>
      <dt>Company</dt><dd>${esc(e.company)}</dd>
      <dt>Code</dt><dd class="mono">${esc(e.claim_code)}</dd>
      <dt>Won at</dt><dd>${fmt(e.committed_at)}</dd>
      ${collected ? `<dt>Collected</dt><dd>${fmt(e.collected_at)} by ${esc(e.collected_by_name)}</dd>` : ''}
    </dl>
    ${note ? `<p class="alert">${esc(note)}</p>` : ''}
    ${collected ? '' : '<button class="btn" id="redeem">Mark as collected</button>'}
  </div>`;
  document.getElementById('redeem')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    if (!confirm(`Hand over ${e.gift_name} to ${e.full_name} and mark code ${e.claim_code} as collected?`)) return;
    btn.disabled = true;
    try {
      const r = await call<{ ok: boolean; error?: string; entry?: Entry }>('spin_admin_redeem', { p_code: e.claim_code });
      if (r.ok) showEntry(r.entry!, '');
      else if (r.error === 'already_collected') showEntry(r.entry!, 'This code was already collected. Do not hand over a second gift.');
      else showEntry(e, 'Code not found.');
    } catch (err) {
      btn.disabled = false;
      showEntry(e, errorText(err));
    }
  });
}

// Stock and activity ---------------------------------------------------------------------

async function renderStock() {
  let o: Overview;
  try {
    o = await call<Overview>('spin_admin_overview');
  } catch (e) {
    view().innerHTML = `<section class="panel"><p class="alert">${errorText(e)}</p></section>`;
    return;
  }
  const c = o.counters;
  view().innerHTML = `<section class="panel">
    <div class="status-line">
      <span class="pill ${o.live ? 'on' : 'off'}">${o.paused ? 'Paused' : o.live ? 'Live' : 'Not live'}</span>
      <span>Event day ${o.event_day} of ${o.event_days}</span>
      <span>Last activity ${o.last_event_at ? fmt(o.last_event_at) : 'none'}</span>
      ${o.demo ? '<span class="pill demo">Demo database</span>' : ''}
    </div>
    <h2>Stock</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Gift</th><th>Total</th><th>Released to date</th><th>Won</th><th>Reserved now</th><th>Collected</th><th>Available now</th></tr></thead>
      <tbody>${o.gifts.map((g) => `<tr><th scope="row">${esc(g.name)}</th><td>${g.total}</td><td>${g.allocation}</td>
        <td>${g.committed}</td><td>${g.reserved}</td><td>${g.collected}</td><td class="strong">${g.available}</td></tr>`).join('')}</tbody>
    </table></div>
    <h2>Activity</h2>
    <div class="counters">
      ${[['Sessions started', c.sessions], ['Spins', c.spins], ['Gift winners', c.completions], ['Game overs', c.game_overs],
        ['Participation gifts', c.participation], ['Already played', c.already_played], ['Collected', c.collected]]
        .map(([l, v]) => `<div><span>${l}</span><strong>${v}</strong></div>`).join('')}
    </div>
    ${o.last_error ? `<p class="muted small">Last app error ${fmt(o.last_error.at)}: ${esc(o.last_error.message)} (session ${esc(o.last_error.session_id)})</p>` : ''}
    <p class="muted small">Refreshes every 15 seconds. Updated ${fmt(o.now)}.</p>
  </section>`;
}

// Controls and exports ---------------------------------------------------------------------

async function renderControls() {
  let o: Overview;
  try {
    o = await call<Overview>('spin_admin_overview');
  } catch (e) {
    view().innerHTML = `<section class="panel"><p class="alert">${errorText(e)}</p></section>`;
    return;
  }
  const manager = me?.role === 'manager';
  view().innerHTML = `<section class="panel">
    <h2>Pause switch</h2>
    <p>${o.paused ? 'The challenge is <strong>paused</strong>. Visitors who have not started see a closed message. Visitors already playing can finish.'
      : 'The challenge is <strong>open</strong>. Pause it when the QR stand is removed or in an emergency.'}</p>
    <button class="btn ${o.paused ? '' : 'danger'}" id="pause">${o.paused ? 'Resume the challenge' : 'Pause the challenge'}</button>
  </section>
  ${manager ? `<section class="panel">
    <h2>Add stock</h2>
    <p class="muted">Adds units to a gift from today. Stock cannot be removed here.</p>
    <form id="stock" class="grid2">
      <label class="field"><span>Gift</span><select name="gift">${o.gifts.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Units to add</span><input name="qty" type="number" min="1" max="500" required></label>
      <label class="field wide"><span>Note <small>Optional</small></span><input name="note" maxlength="200"></label>
      <button class="btn wide">Add stock</button>
    </form>
    <p id="stock-msg" aria-live="polite"></p>
  </section>
  <section class="panel">
    <h2>Exports</h2>
    <div class="export-list">
      <button class="btn secondary" data-export="leads">Leads (all forms) CSV</button>
      <button class="btn secondary" data-export="winners">Winners with residence CSV</button>
      <button class="btn secondary" data-export="unclaimed">Unclaimed prizes CSV</button>
    </div>
    <p id="export-msg" aria-live="polite"></p>
  </section>` : '<section class="panel"><p class="muted">Stock and exports are available to managers.</p></section>'}`;

  document.getElementById('pause')!.addEventListener('click', async (ev) => {
    const next = !o.paused;
    if (!confirm(next ? 'Pause the challenge now? Visitors who have not started will not be able to play.' : 'Resume the challenge now?')) return;
    (ev.currentTarget as HTMLButtonElement).disabled = true;
    try { await call('spin_admin_set_paused', { p_paused: next }); } catch (e) { alert(errorText(e)); }
    renderControls();
  });

  document.getElementById('stock')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget as HTMLFormElement;
    const gift = (f.gift as HTMLSelectElement).value;
    const qty = Number((f.qty as HTMLInputElement).value);
    const name = o.gifts.find((g) => g.id === gift)?.name;
    if (!confirm(`Add ${qty} units of ${name}?`)) return;
    const msg = document.getElementById('stock-msg')!;
    try {
      const r = await call<{ ok: boolean; error?: string }>('spin_admin_add_stock', { p_gift: gift, p_qty: qty, p_note: (f.note as HTMLInputElement).value || null });
      msg.textContent = r.ok ? `${qty} units of ${name} added.` : 'Enter a quantity between 1 and 500.';
      if (r.ok) f.reset();
    } catch (e) {
      msg.textContent = errorText(e);
    }
  });

  app.querySelectorAll<HTMLButtonElement>('[data-export]').forEach((b) => b.addEventListener('click', async () => {
    const kind = b.dataset.export!;
    const msg = document.getElementById('export-msg')!;
    try {
      const rows = await call<Record<string, unknown>[]>('spin_admin_export', { p_kind: kind });
      download(`adipec2026-${kind}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
      msg.textContent = `${rows.length} rows exported.`;
    } catch (e) {
      msg.textContent = errorText(e);
    }
  }));
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    let s = v == null ? '' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    // Stop spreadsheet formulas from running when the file is opened in Excel.
    if (/^[=+\-@\t\r]/.test(s) && !/^\+\d+$/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}

function download(name: string, csv: string) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Start ------------------------------------------------------------------------------------

(async () => {
  if (!configured) { app.innerHTML = '<p>VITE_SUPABASE_URL and VITE_SUPABASE_KEY are missing.</p>'; return; }
  load();
  if (!auth) return renderLogin();
  try { await afterSignIn(); } catch { signOut(); }
})();
