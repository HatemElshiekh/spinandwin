import '../shared/base.css';
import './game.css';
import { rpc, newKey, esc, onNetwork, configured, ApiError } from '../shared/api';
import { wheelSvg, spinTo, showSlice, sliceFor, type SliceId } from './wheel';
import { termsHtml } from './terms';

// Shape of spin.state_json() on the server.
interface Question {
  id: string; text: string; hint: string; slot: number; attempt: number; remaining_ms: number;
  options: { id: string; text: string }[];
}
interface State {
  session_id: string;
  state: 'paused' | 'ready' | 'spin_again' | 'questions' | 'form_gift' | 'form_participation'
    | 'done_gift' | 'done_participation' | 'already_played';
  spin_count: number;
  last_outcome: string | null;
  gift: { id: string; name: string } | null;
  slot: number;
  questions_required: number;
  wrong_count: number;
  max_wrong: number;
  timer_seconds: number;
  question: Question | null;
  end_reason: string | null;
  entry: { type: string; claim_code: string; full_name: string; gift_name: string | null } | null;
  all_claimed: boolean;
  paused: boolean;
  demo: boolean;
}
interface Resp { ok: boolean; error?: string; state?: State; result?: Record<string, string>; fields?: Record<string, string> }

const APPROVED_WINNER_LINE = 'Your gift is ready. Show this screen to a Gulf Cryo representative to collect it.';
const DEMO_TOOLS = import.meta.env.VITE_DEMO_TOOLS === 'true';
const FEEDBACK_MS = 1500;
const GRACE_MS = 2500;

const app = document.getElementById('app')!;
const progressEl = document.getElementById('progress')!;
const netEl = document.getElementById('net')!;

let st: State | null = null;
let ui: { step?: 'welcome' | 'spin'; reveal?: boolean; spinMsg?: string; celebrate?: boolean } = {};
let timerHandle = 0;
let failures = 0;
const pendingKeys: Record<string, string> = {};

// Device and session ------------------------------------------------------------------

function storage(): Storage | null {
  try { localStorage.setItem('gc_t', '1'); localStorage.removeItem('gc_t'); return localStorage; } catch { return null; }
}
function deviceToken(): string {
  const s = storage();
  let t = s?.getItem('gc_spin_device') ?? null;
  if (!t || t.length < 16) {
    t = newKey() + newKey();
    s?.setItem('gc_spin_device', t);
  }
  return t;
}
const token = deviceToken();
const src = new URLSearchParams(location.search).get('src')?.slice(0, 60) ?? null;

// One key per pending action, reused until the server answers, so retries are safe.
const keyFor = (action: string) => (pendingKeys[action] ??= newKey());
const doneKey = (action: string) => { delete pendingKeys[action]; };

async function call(fn: string, args: Record<string, unknown>): Promise<Resp> {
  const r = await rpc<Resp>(fn, args);
  failures = 0;
  if (r?.state) st = r.state;
  return r;
}
const sess = () => ({ p_session: st!.session_id, p_token: token });

onNetwork((on) => {
  netEl.hidden = !on;
});

function logError(e: unknown) {
  console.error(e);
  if (st?.session_id) {
    rpc('spin_log_client_error', { ...sess(), p_message: String((e as Error)?.message ?? e) }).catch(() => {});
  }
}

// Progress bar -----------------------------------------------------------------------

function setProgress() {
  const total = 7;
  let step = 0;
  if (st) {
    switch (st.state) {
      case 'ready': step = ui.step === 'spin' ? 1 : 0; break;
      case 'spin_again': step = 1; break;
      case 'questions': step = ui.reveal || !st.question ? 1.5 : 1 + st.slot; break;
      case 'form_gift': case 'form_participation': step = 6; break;
      case 'done_gift': case 'done_participation': case 'already_played': step = 7; break;
    }
  }
  const pct = Math.round((step / total) * 100);
  progressEl.innerHTML = `<div class="bar" style="width:${pct}%"></div>`;
  progressEl.setAttribute('aria-valuenow', String(pct));
}

// Rendering --------------------------------------------------------------------------

function screen(html: string, focus = true) {
  clearInterval(timerHandle);
  app.innerHTML = html + demoPanel();
  setProgress();
  window.scrollTo(0, 0);
  if (focus) app.querySelector<HTMLElement>('h1, h2')?.focus();
  bindDemo();
}

function render() {
  if (!st) return;
  if (st.state === 'paused' || (st.state === 'ready' && st.paused)) return renderPaused();
  switch (st.state) {
    case 'ready':
      if (st.all_claimed) return renderAllClaimed();
      return ui.step === 'spin' ? renderSpin() : renderWelcome();
    case 'spin_again': return renderSpin();
    case 'questions': return ui.reveal || !st.question ? renderReveal() : renderQuestion();
    case 'form_gift': return renderForm(true);
    case 'form_participation': return renderForm(false);
    case 'done_gift': return renderDone(true);
    case 'done_participation': return renderDone(false);
    case 'already_played': return renderAlreadyPlayed();
  }
}

function renderPaused() {
  screen(`<section class="card center">
    <h1 tabindex="-1">The challenge is closed right now</h1>
    <p>Please check with a Gulf Cryo representative at the booth.</p>
  </section>`);
}

function renderWelcome() {
  screen(`<section class="card">
    <h1 tabindex="-1">Gulf Cryo booth challenge</h1>
    <p class="lead">Spin the wheel to reserve a gift. Answer 4 questions using the walls of this booth. Then collect your gift here.</p>
    <ul class="rules">
      <li>One game per person.</li>
      <li>One wrong answer is allowed per question, and two in total.</li>
      <li>You have ${st!.timer_seconds} seconds per question. If time runs out, the game ends.</li>
      <li>Gifts are collected at the booth only, while stock lasts.</li>
    </ul>
    <button class="link-btn" data-terms>Full terms</button>
    <button class="btn" data-go>Spin the wheel</button>
  </section>`);
  app.querySelector('[data-go]')!.addEventListener('click', () => { ui.step = 'spin'; render(); });
  bindTerms();
}

function renderAllClaimed() {
  screen(`<section class="card">
    <h1 tabindex="-1">Today's gifts have all been claimed</h1>
    <p>You can still register to receive a participation gift from the Gulf Cryo team.</p>
    <button class="btn" data-go>Register</button>
    <button class="link-btn" data-terms>Full terms</button>
  </section>`);
  app.querySelector<HTMLButtonElement>('[data-go]')!.addEventListener('click', (ev) =>
    act(ev.currentTarget as HTMLButtonElement, async () => { await call('spin_participate', sess()); render(); }));
  bindTerms();
}

function renderSpin() {
  const again = st!.state === 'spin_again';
  screen(`<section class="card center">
    <h1 tabindex="-1">${again ? 'Spin once more' : 'Spin the wheel'}</h1>
    <p class="muted" id="spin-msg" aria-live="polite">${esc(ui.spinMsg ?? (again ? 'Not this time. You have one more spin.' : 'Tap the button to spin.'))}</p>
    ${wheelSvg()}
    <button class="btn" data-spin>${again ? 'Spin again' : 'Spin'}</button>
  </section>`);
  if (again) showSlice(app, sliceFor('try_again', st!.session_id));
  app.querySelector<HTMLButtonElement>('[data-spin]')!.addEventListener('click', (ev) => doSpin(ev.currentTarget as HTMLButtonElement));
}

async function doSpin(btn: HTMLButtonElement) {
  btn.disabled = true;
  btn.textContent = 'Spinning';
  let r: Resp;
  try {
    r = await call('spin_spin', { ...sess(), p_key: keyFor('spin' + st!.spin_count) });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Spin';
    return showError(e, () => render());
  }
  if (!r.ok) { ui.spinMsg = undefined; return render(); }
  doneKey('spin' + (r.result!.spin_no ? Number(r.result!.spin_no) - 1 : 0));
  const outcome = r.result!.outcome;
  const msg = document.getElementById('spin-msg')!;
  if (outcome === 'all_claimed') { ui = {}; return render(); }
  const slice = outcome === 'try_again' ? 'try_again' : (r.result!.gift_id as SliceId);
  await spinTo(app, sliceFor(slice, st!.session_id));
  if (outcome === 'try_again') {
    ui.spinMsg = 'Not this time. You have one more spin.';
    msg.textContent = ui.spinMsg;
    btn.disabled = false;
    btn.textContent = 'Spin again';
    app.querySelector('h1')!.textContent = 'Spin once more';
    return;
  }
  if (outcome === 'gift') {
    msg.textContent = `${r.result!.gift_name}.`;
    await new Promise((res) => setTimeout(res, 900));
    ui = { reveal: true };
    return render();
  }
  // no_stock: the drawn gift has no units left today.
  msg.textContent = `All ${r.result!.gift_name} gifts for today have been claimed.`;
  btn.remove();
  const cont = document.createElement('button');
  cont.className = 'btn';
  cont.textContent = 'Continue';
  cont.addEventListener('click', () => { ui = {}; render(); });
  msg.after(cont);
  cont.focus();
}

function renderReveal() {
  const g = st!.gift;
  screen(`<section class="card center">
    <p class="eyebrow">Your gift</p>
    <h1 tabindex="-1">${esc(g?.name)}</h1>
    <p>It is reserved for you while you complete the challenge. Answer ${st!.questions_required} questions. The answers are on the walls of this booth.</p>
    <ul class="rules left">
      <li>${st!.timer_seconds} seconds per question.</li>
      <li>One wrong answer is allowed per question, and two in total.</li>
    </ul>
    <button class="btn" data-go>Start the questions</button>
  </section>`);
  app.querySelector<HTMLButtonElement>('[data-go]')!.addEventListener('click', (ev) =>
    act(ev.currentTarget as HTMLButtonElement, async () => {
      await call('spin_question', sess());
      ui = {};
      render();
    }));
}

const ICON_OK = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="3"/></svg>';
const ICON_BAD = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3"/></svg>';

function questionNote(q: Question): string {
  if (q.attempt === 2) return 'This is a replacement question. Another wrong answer ends the game. If time runs out, the game ends.';
  if (st!.wrong_count >= st!.max_wrong) return 'You have used both wrong answers. Another wrong answer ends the game. If time runs out, the game ends.';
  return 'One wrong answer is allowed for this question. If time runs out, the game ends.';
}

function renderQuestion() {
  const q = st!.question!;
  const total = st!.timer_seconds;
  screen(`<section class="card">
    <div class="q-head">
      <p class="counter">Question ${q.slot} of ${st!.questions_required}</p>
      <p class="timer" aria-live="off"><span id="secs">${total}</span> s</p>
    </div>
    <div class="timebar" aria-hidden="true"><div id="timebar"></div></div>
    <h2 tabindex="-1" class="q-text">${esc(q.text)}</h2>
    <div class="options" role="group" aria-label="Answers">
      ${q.options.map((o) => `<button class="opt" data-opt="${esc(o.id)}"><span>${esc(o.text)}</span></button>`).join('')}
    </div>
    <p class="feedback" id="feedback" aria-live="assertive"></p>
    <button class="link-btn" data-hint aria-expanded="false">Hint</button>
    <p class="hint" id="hint" hidden>${esc(q.hint)}</p>
    <p class="note small">${questionNote(q)}</p>
  </section>`);

  const hintBtn = app.querySelector<HTMLButtonElement>('[data-hint]')!;
  hintBtn.addEventListener('click', () => {
    const h = document.getElementById('hint')!;
    h.hidden = !h.hidden;
    hintBtn.setAttribute('aria-expanded', String(!h.hidden));
  });

  // Countdown from the server's remaining time. The server deadline is what counts.
  const end = performance.now() + Math.min(q.remaining_ms, (total + 2) * 1000);
  const secsEl = document.getElementById('secs')!;
  const barEl = document.getElementById('timebar')!;
  let answered = false;
  const tick = () => {
    const left = Math.max(0, end - performance.now());
    const shown = Math.min(total, Math.ceil(left / 1000));
    secsEl.textContent = String(shown);
    barEl.style.width = `${Math.min(100, (left / (total * 1000)) * 100)}%`;
    barEl.classList.toggle('low', shown <= 10);
    if (left <= 0 && !answered) {
      answered = true;
      clearInterval(timerHandle);
      lockOptions();
      document.getElementById('feedback')!.textContent = 'Time is up. Checking.';
      setTimeout(confirmTimeout, GRACE_MS);
    }
  };
  tick();
  timerHandle = window.setInterval(tick, 250);

  app.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (answered) return;
      answered = true;
      clearInterval(timerHandle);
      lockOptions();
      b.classList.add('pending');
      await sendAnswer(q, b);
    }));
}

function lockOptions() {
  app.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((x) => { x.disabled = true; });
}

async function sendAnswer(q: Question, b: HTMLButtonElement) {
  const fb = document.getElementById('feedback')!;
  let r: Resp;
  try {
    r = await call('spin_answer', { ...sess(), p_question: q.id, p_option: b.dataset.opt, p_key: keyFor('answer' + q.id) });
  } catch (e) {
    return showError(e, () => sendAnswer(q, b));
  }
  doneKey('answer' + q.id);
  b.classList.remove('pending');
  const v = r.result?.verdict;
  if (v === 'correct') {
    b.classList.add('right');
    b.insertAdjacentHTML('beforeend', ICON_OK);
    fb.innerHTML = '<span class="ok-text">Correct</span>';
  } else if (v === 'wrong') {
    b.classList.add('wrong');
    b.insertAdjacentHTML('beforeend', ICON_BAD);
    fb.innerHTML = st!.state === 'questions'
      ? '<span class="bad-text">Wrong answer, try again</span>'
      : '<span class="bad-text">Wrong answer</span>';
  } else if (v === 'timeout') {
    fb.textContent = 'Time is up.';
  }
  setTimeout(render, v ? FEEDBACK_MS : 0);
}

async function confirmTimeout() {
  try {
    await call('spin_state', sess());
  } catch (e) {
    return showError(e, confirmTimeout);
  }
  if (st!.state === 'questions' && st!.question && st!.question.remaining_ms > 0) {
    // The server still has time on the clock (slow phone clock): carry on.
    return render();
  }
  if (st!.state === 'questions') return void setTimeout(confirmTimeout, 1000);
  render();
}

// Form -------------------------------------------------------------------------------

const RESIDENCE = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah',
  'Saudi Arabia', 'Kuwait', 'Qatar', 'Bahrain', 'Oman'];
const CODES: [string, string][] = [['+971', 'UAE +971'], ['+966', 'Saudi Arabia +966'], ['+965', 'Kuwait +965'],
  ['+974', 'Qatar +974'], ['+973', 'Bahrain +973'], ['+968', 'Oman +968'], ['+20', 'Egypt +20'], ['+962', 'Jordan +962'],
  ['+961', 'Lebanon +961'], ['+964', 'Iraq +964'], ['+90', 'Turkey +90'], ['+91', 'India +91'], ['+92', 'Pakistan +92'],
  ['+44', 'UK +44'], ['+1', 'USA or Canada +1'], ['', 'Other (type the full number with +)']];

function formHeader(gift: boolean): string {
  if (gift) {
    const head = ui.celebrate !== false
      ? `<div class="done-mark" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="23"/><path d="M15 27l7 7 15-16"/></svg></div>` : '';
    return `${head}<h1 tabindex="-1">Challenge complete</h1>
      <p>All ${st!.questions_required} answers are correct. Complete the form to collect your ${esc(st!.gift?.name)}.</p>`;
  }
  const reason: Record<string, string> = {
    timeout: 'Time is up. The game has ended.',
    wrong_twice: 'That answer was not correct. The game has ended.',
    too_many_wrong: 'That answer was not correct. The game has ended.',
    expired: 'Your gift reservation has expired. The game has ended.',
    no_stock: 'The gift you landed on has been fully claimed for today.',
    all_claimed: "Today's gifts have all been claimed.",
  };
  return `<h1 tabindex="-1">${esc(reason[st!.end_reason ?? ''] ?? 'The game has ended.')}</h1>
    <p>Please complete the form to collect your participation gift.</p>`;
}

function renderForm(gift: boolean) {
  screen(`<section class="card">
    ${formHeader(gift)}
    <form id="lead" novalidate>
      <label class="field" data-f="full_name"><span>Full name</span><input name="full_name" autocomplete="name" maxlength="120" required></label>
      <label class="field" data-f="company"><span>Company</span><input name="company" autocomplete="organization" maxlength="120" required></label>
      <label class="field" data-f="job_title"><span>Job title <small>Optional</small></span><input name="job_title" autocomplete="organization-title" maxlength="120"></label>
      <label class="field" data-f="email"><span>Email</span><input name="email" type="email" inputmode="email" autocomplete="email" maxlength="200" required></label>
      <div class="field" data-f="phone"><span id="ph-l">Mobile number</span>
        <div class="phone">
          <select name="cc" aria-label="Country code">${CODES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
          <input name="phone" type="tel" inputmode="tel" autocomplete="tel-national" aria-labelledby="ph-l" maxlength="20" required>
        </div>
      </div>
      <label class="field" data-f="residence"><span>Emirate or country of residence</span>
        <select name="residence" required><option value="">Select</option>
          ${RESIDENCE.map((r) => `<option>${esc(r)}</option>`).join('')}<option value="other">Other country</option></select>
      </label>
      <label class="field" data-f="residence_other" hidden><span>Country of residence</span><input name="residence_other" maxlength="80"></label>
      <div class="field" data-f="consent_contact">
        <label class="check"><input type="checkbox" name="consent_contact" required>
          <span>I agree that Gulf Cryo may use these details to run this promotion and to contact me about Gulf Cryo products and services.</span></label>
      </div>
      <label class="check"><input type="checkbox" name="consent_marketing">
        <span>Send me Gulf Cryo news and updates by email. <span class="muted">Optional</span></span></label>
      <p class="small"><button type="button" class="link-btn" data-terms>Terms and privacy</button></p>
      <button class="btn" type="submit">Submit</button>
    </form>
  </section>`);
  ui.celebrate = false;
  bindTerms();
  const f = document.getElementById('lead') as HTMLFormElement;
  const res = f.elements.namedItem('residence') as HTMLSelectElement;
  res.addEventListener('change', () => {
    (app.querySelector('[data-f="residence_other"]') as HTMLElement).hidden = res.value !== 'other';
  });
  f.addEventListener('submit', (ev) => { ev.preventDefault(); submitForm(f); });
}

function phoneE164(cc: string, raw: string): string {
  let n = raw.replace(/[\s\-().]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (n.startsWith('+') || !cc) return n.startsWith('+') ? n : '+' + n;
  return cc + n.replace(/^0+/, '');
}

function validate(p: Record<string, unknown>): Record<string, string> {
  const e: Record<string, string> = {};
  if (String(p.full_name).length < 2) e.full_name = 'Please enter your full name.';
  if (!String(p.company)) e.company = 'Please enter your company.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(p.email))) e.email = 'Please enter a valid email address.';
  if (!/^\+[1-9][0-9]{7,14}$/.test(String(p.phone))) e.phone = 'Please enter a valid mobile number.';
  if (String(p.residence).length < 2) e.residence = 'Please select where you live.';
  if (!p.consent_contact) e.consent_contact = 'Please tick this box to continue.';
  return e;
}

const FIELD_MSG: Record<string, string> = {
  full_name: 'Please enter your full name.', company: 'Please enter your company.', job_title: 'Please shorten your job title.',
  email: 'Please enter a valid email address.', phone: 'Please enter a valid mobile number.',
  residence: 'Please select where you live.', consent_contact: 'Please tick this box to continue.',
};

function showFieldErrors(f: HTMLFormElement, errors: Record<string, string>) {
  f.querySelectorAll('.err').forEach((x) => x.remove());
  f.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid'));
  let first: HTMLElement | null = null;
  for (const [k, msg] of Object.entries(errors)) {
    const box = f.querySelector<HTMLElement>(`[data-f="${k === 'residence' && (f.elements.namedItem('residence') as HTMLSelectElement).value === 'other' ? 'residence_other' : k}"]`);
    if (!box) continue;
    box.classList.add('invalid');
    box.insertAdjacentHTML('beforeend', `<span class="err">${esc(FIELD_MSG[k] ?? msg)}</span>`);
    first ??= box.querySelector('input, select');
  }
  first?.focus();
}

async function submitForm(f: HTMLFormElement) {
  const v = (n: string) => ((f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '').trim();
  const c = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).checked;
  const payload = {
    full_name: v('full_name'), company: v('company'), job_title: v('job_title'), email: v('email'),
    phone: phoneE164(v('cc'), v('phone')),
    residence: v('residence') === 'other' ? v('residence_other') : v('residence'),
    consent_contact: c('consent_contact'), consent_marketing: c('consent_marketing'),
  };
  const errors = validate(payload);
  if (Object.keys(errors).length) return showFieldErrors(f, errors);
  const btn = f.querySelector<HTMLButtonElement>('button[type=submit]')!;
  btn.disabled = true;
  btn.textContent = 'Sending';
  let r: Resp;
  try {
    r = await call('spin_submit', { ...sess(), p_payload: payload, p_key: keyFor('submit') });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Submit';
    return showError(e, () => submitForm(f), true);
  }
  if (!r.ok && r.error === 'invalid') {
    btn.disabled = false;
    btn.textContent = 'Submit';
    return showFieldErrors(f, r.fields ?? {});
  }
  doneKey('submit');
  render();
}

// Final screens ----------------------------------------------------------------------

function renderDone(gift: boolean) {
  const e = st!.entry!;
  screen(`<section class="card center final">
    <h1 tabindex="-1">${gift ? esc(APPROVED_WINNER_LINE) : 'Your participation gift is ready. Show this screen to a Gulf Cryo representative to collect it.'}</h1>
    <p class="gift-name">${esc(gift ? e.gift_name : 'Participation Gift')}</p>
    <p class="code-label">Claim code</p>
    <p class="code" aria-label="Claim code ${esc(e.claim_code.split('').join(' '))}">${esc(e.claim_code)}</p>
    <p class="name">${esc(e.full_name)}</p>
    <p class="muted small">You can reopen this screen from the same link on this phone.</p>
  </section>`);
}

function renderAlreadyPlayed() {
  screen(`<section class="card center">
    <h1 tabindex="-1">You have already taken part</h1>
    <p>This email or mobile number has already been used in the challenge. The challenge is available once per person.</p>
    <p class="muted">Thank you for visiting the Gulf Cryo booth.</p>
  </section>`);
}

// Errors, terms and the action helper --------------------------------------------------

function showError(e: unknown, retry: () => void, keepScreen = false) {
  logError(e);
  failures++;
  const code = e instanceof ApiError ? e.code : undefined;
  const html = `<div class="error-box" role="alert">
      <p><strong>We could not reach the server.</strong> Please check your connection and try again.</p>
      ${failures >= 2 ? '<p>If this keeps happening, please ask a Gulf Cryo representative.</p>' : ''}
      ${code ? `<p class="muted small">Code ${esc(code)}</p>` : ''}
      <button class="btn" data-retry>Try again</button>
    </div>`;
  if (keepScreen && app.querySelector('.card')) {
    app.querySelector('.error-box')?.remove();
    app.querySelector('.card')!.insertAdjacentHTML('beforeend', html);
  } else {
    screen(`<section class="card">${html}</section>`, false);
  }
  app.querySelector<HTMLButtonElement>('[data-retry]')!.addEventListener('click', (ev) => {
    (ev.currentTarget as HTMLButtonElement).disabled = true;
    app.querySelector('.error-box')?.remove();
    retry();
  });
}

async function act(btn: HTMLButtonElement, fn: () => Promise<void>) {
  btn.disabled = true;
  try { await fn(); } catch (e) { btn.disabled = false; showError(e, () => render()); }
}

function bindTerms() {
  app.querySelectorAll('[data-terms]').forEach((b) => b.addEventListener('click', openTerms));
}

function openTerms() {
  const d = document.createElement('dialog');
  d.className = 'terms';
  d.innerHTML = `<div class="terms-body">${termsHtml(st?.timer_seconds ?? 45)}</div>
    <form method="dialog"><button class="btn">Close</button></form>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
}

// Demo tools (test link only; the database refuses them unless demo mode is on) ---------

function demoPanel(): string {
  if (!DEMO_TOOLS || !st?.demo) return '';
  return `<details class="demo"><summary>Demo tools (test link only)</summary>
    <div class="demo-body">
      <button class="btn small secondary" data-demo="reset">Reset my session</button>
      <label>Event day <input type="number" min="0" max="10" id="d-day" placeholder="0 = today"></label>
      <label>Timer seconds <input type="number" min="5" max="300" id="d-timer" placeholder="45"></label>
      <button class="btn small secondary" data-demo="settings">Apply day and timer</button>
      <label>Gift <select id="d-gift"><option value="seleo">Seleo Machine</option><option value="mall">Mall Voucher</option>
        <option value="entertainment">Entertainment Voucher</option><option value="black_kit">Black Kit</option></select></label>
      <label>Total <input type="number" min="0" id="d-total"></label>
      <label>Per day <input type="number" min="0" id="d-daily"></label>
      <button class="btn small secondary" data-demo="seed">Set stock</button>
      <button class="btn small danger" data-demo="all">Reset all test data</button>
      <p class="small muted" id="d-out"></p>
    </div></details>`;
}

function bindDemo() {
  const out = () => document.getElementById('d-out')!;
  const num = (id: string) => { const v = (document.getElementById(id) as HTMLInputElement).value; return v === '' ? null : Number(v); };
  app.querySelectorAll<HTMLButtonElement>('[data-demo]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const k = b.dataset.demo;
      if (k === 'reset') {
        await rpc('spin_demo_reset_session', sess());
        location.reload();
      } else if (k === 'settings') {
        out().textContent = JSON.stringify(await rpc('spin_demo_settings', { p_day: num('d-day'), p_timer: num('d-timer') }));
      } else if (k === 'seed') {
        await rpc('spin_demo_seed_stock', { p_gift: (document.getElementById('d-gift') as HTMLSelectElement).value,
          p_total: num('d-total') ?? 0, p_daily: num('d-daily') ?? 0 });
        out().textContent = 'Stock updated.';
      } else if (k === 'all' && confirm('Delete every test session and entry, and restore the gift table?')) {
        await rpc('spin_demo_reset_all', {});
        location.reload();
      }
    } catch (e) {
      out().textContent = String((e as Error).message);
    }
  }));
}

// Start ------------------------------------------------------------------------------

async function start() {
  if (!configured) {
    app.innerHTML = '<section class="card"><h1>Not configured</h1><p>VITE_SUPABASE_URL and VITE_SUPABASE_KEY are missing.</p></section>';
    return;
  }
  try {
    const r = await call('spin_start', { p_device_token: token, p_src: src });
    if (!r.ok && r.error === 'rate_limited') {
      screen(`<section class="card center"><h1 tabindex="-1">Please wait a moment</h1>
        <p>Many people are starting the challenge right now. Try again in a minute.</p>
        <button class="btn" data-retry>Try again</button></section>`);
      app.querySelector('[data-retry]')!.addEventListener('click', start);
      return;
    }
    if (!r.ok && r.error === 'no_session') {
      // The session was removed (demo reset). Start fresh.
      storage()?.removeItem('gc_spin_device');
      location.reload();
      return;
    }
    if (st?.state === 'spin_again') ui.spinMsg = undefined;
    render();
  } catch (e) {
    showError(e, start);
  }
}

// Returning to the tab after the phone was locked: re-sync with the server.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && st && st.state === 'questions' && !ui.reveal) {
    call('spin_state', sess()).then(render).catch(() => {});
  }
});

window.addEventListener('error', (ev) => logError(ev.error ?? ev.message));
window.addEventListener('unhandledrejection', (ev) => logError(ev.reason));

start();
