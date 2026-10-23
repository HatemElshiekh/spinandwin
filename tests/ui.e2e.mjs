// Browser test of the visitor app and the dashboard, against the local API stand-in.
// Needs: local Postgres (tests/reset-local.sh), `node tests/local-api.mjs` on :54321 and
// `npm run build && npx vite preview --port 4173` built with VITE_SUPABASE_URL=http://localhost:54321.
//
//   SHOTS=/some/folder node tests/ui.e2e.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { chromium, devices } = require(`${execSync('npm root -g').toString().trim()}/playwright`);

const BASE = process.env.BASE || 'http://localhost:4173';
const SHOTS = process.env.SHOTS || '/tmp';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres@%2Fvar%2Ftmp%2Fpgtest:5433/spintest' });
const sql = async (q, p = []) => (await db.query(q, p)).rows;
const STAFF = '00000000-0000-4000-8000-000000000001';

await sql(`update spin.config set demo_mode = true`);
await sql(`select public.spin_demo_reset_all()`);
await sql(`update spin.config set demo_mode = true, event_start = (now() at time zone 'Asia/Dubai')::date,
           event_end = (now() at time zone 'Asia/Dubai')::date + 30, rate_limit_per_min = 1000`);
await sql(`insert into spin.staff (user_id, name, role) values ($1, 'Local Manager', 'manager') on conflict do nothing`, [STAFF]);

const browser = await chromium.launch();
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(`PASS ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`); throw e; }
};

// The open question for this browser's session, and the text of its correct option.
async function correctText(page) {
  const token = await page.evaluate(() => localStorage.getItem('gc_spin_device'));
  const [row] = await sql(`select q.options, q.correct_option from spin.session_questions sq
    join spin.sessions s on s.id = sq.session_id join spin.questions q on q.id = sq.question_id
    where s.device_token = $1 and sq.result is null order by sq.id desc limit 1`, [token]);
  const opts = row.options;
  return { right: opts.find((o) => o.id === row.correct_option).text, wrong: opts.find((o) => o.id !== row.correct_option).text };
}

async function spinToGift(page) {
  await page.getByRole('button', { name: 'Spin the wheel' }).click();
  await page.getByRole('button', { name: 'Spin', exact: true }).click();
  const again = page.getByRole('button', { name: 'Spin again' });
  const start = page.getByRole('button', { name: 'Start the questions' });
  await Promise.race([again.waitFor(), start.waitFor()]);
  if (await again.isVisible()) {
    await page.screenshot({ path: `${SHOTS}/03-try-again.png` });
    await again.click();
  }
  await start.waitFor();
}

const phone = { ...devices['iPhone 13'], reducedMotion: 'reduce' };

try {
  // Winner path with one wrong answer, a refresh mid-question, and the final screen.
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await step('welcome screen loads with rules and progress bar', async () => {
    await page.goto(`${BASE}/challenge/?src=qr-test`);
    await page.getByRole('heading', { name: 'Gulf Cryo booth challenge' }).waitFor();
    assert.ok(await page.locator('#progress .bar').count());
    await page.screenshot({ path: `${SHOTS}/01-welcome.png` });
  });

  await step('terms open and close', async () => {
    await page.getByRole('button', { name: 'Full terms' }).click();
    await page.getByRole('heading', { name: /Terms of the Gulf Cryo booth challenge/ }).waitFor();
    await page.screenshot({ path: `${SHOTS}/02-terms.png` });
    await page.getByRole('button', { name: 'Close' }).click();
  });

  await step('spin reserves a gift', async () => {
    await spinToGift(page);
    await page.screenshot({ path: `${SHOTS}/04-gift-reserved.png` });
  });

  await step('question screen: counter, timer, hint, note', async () => {
    await page.getByRole('button', { name: 'Start the questions' }).click();
    await page.getByText('Question 1 of 4').waitFor();
    await page.getByText('One wrong answer is allowed for this question. If time runs out, the game ends.').waitFor();
    await page.getByRole('button', { name: 'Hint' }).click();
    await page.screenshot({ path: `${SHOTS}/05-question.png` });
  });

  await step('wrong answer turns red and brings a replacement for the same slot', async () => {
    const { wrong } = await correctText(page);
    const before = await page.locator('.q-text').textContent();
    await page.getByRole('button', { name: wrong, exact: true }).click();
    await page.getByText('Wrong answer, try again').waitFor();
    await page.screenshot({ path: `${SHOTS}/06-wrong.png` });
    await page.waitForFunction((b) => document.querySelector('.q-text')?.textContent !== b, before);
    await page.getByText('Question 1 of 4').waitFor();
    await page.getByText('This is a replacement question.', { exact: false }).waitFor();
  });

  await step('refresh mid-question resumes the same question', async () => {
    const q = await page.locator('.q-text').textContent();
    await page.reload();
    await page.locator('.q-text').waitFor();
    assert.equal(await page.locator('.q-text').textContent(), q);
  });

  await step('four correct answers lead to the celebration and form', async () => {
    for (let i = 0; i < 4; i++) {
      const { right } = await correctText(page);
      await page.getByRole('button', { name: right, exact: true }).click();
      await page.getByText('Correct').waitFor();
      if (i === 0) await page.screenshot({ path: `${SHOTS}/07-correct.png` });
      if (i < 3) await page.getByText(`Question ${i + 2} of 4`).waitFor();
    }
    await page.getByRole('heading', { name: 'Challenge complete' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/08-form.png`, fullPage: true });
  });

  await step('form validation shows field errors', async () => {
    await page.getByRole('button', { name: 'Submit' }).click();
    await page.getByText('Please enter your full name.').waitFor();
    await page.getByText('Please tick this box to continue.').waitFor();
  });

  await step('form submits and shows the approved winner line and claim code', async () => {
    await page.locator('input[name=full_name]').fill('Test Visitor');
    await page.locator('input[name=company]').fill('Test Company');
    await page.locator('input[name=email]').fill('ui.visitor@example.com');
    await page.locator('input[name=phone]').fill('050 123 4567');
    await page.locator('select[name=residence]').selectOption('Abu Dhabi');
    await page.locator('input[name=consent_contact]').check();
    await page.getByRole('button', { name: 'Submit' }).click();
    await page.getByRole('heading', { name: 'Your gift is ready. Show this screen to a Gulf Cryo representative to collect it.' }).waitFor();
    const code = (await page.locator('.code').textContent()).trim();
    assert.match(code, /^[2-9A-HJ-NP-Z]{6}$/);
    const [row] = await sql(`select phone_norm from spin.entries where claim_code = $1`, [code]);
    assert.equal(row.phone_norm, '+971501234567');
    await page.screenshot({ path: `${SHOTS}/09-final.png` });
    globalThis.claimCode = code;
  });

  await step('final screen survives closing and reopening', async () => {
    await page.reload();
    await page.locator('.code').waitFor();
    assert.equal((await page.locator('.code').textContent()).trim(), globalThis.claimCode);
  });

  assert.deepEqual(errors, [], 'no page errors');
  await ctx.close();

  // Timeout ends the game and leads to the participation form.
  await step('timeout ends the game and offers the participation gift', async () => {
    await sql(`select public.spin_demo_settings(null, 5)`);
    const c2 = await browser.newContext(phone);
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/challenge/`);
    await spinToGift(p2);
    await p2.getByRole('button', { name: 'Start the questions' }).click();
    await p2.getByRole('heading', { name: 'Time is up. The game has ended.' }).waitFor({ timeout: 20000 });
    await p2.getByText('Please complete the form to collect your participation gift.').waitFor();
    await p2.screenshot({ path: `${SHOTS}/10-timeout.png` });
    await sql(`select public.spin_demo_settings(null, 45)`);

    await p2.locator('input[name=full_name]').fill('Same Person');
    await p2.locator('input[name=company]').fill('Test Company');
    await p2.locator('input[name=email]').fill('UI.Visitor@Example.com');
    await p2.locator('input[name=phone]').fill('0559999999');
    await p2.locator('select[name=residence]').selectOption('Dubai');
    await p2.locator('input[name=consent_contact]').check();
    await p2.getByRole('button', { name: 'Submit' }).click();
    await p2.getByRole('heading', { name: 'You have already taken part' }).waitFor();
    await p2.screenshot({ path: `${SHOTS}/11-already-played.png` });
    await c2.close();
  });

  // Wheel animation with motion on, captured mid-spin.
  await step('wheel animates for 4 to 6 seconds without reduced motion', async () => {
    const c3 = await browser.newContext({ ...devices['Pixel 7'] });
    const p3 = await c3.newPage();
    await p3.goto(`${BASE}/challenge/`);
    await p3.getByRole('button', { name: 'Spin the wheel' }).click();
    await p3.screenshot({ path: `${SHOTS}/12-wheel.png` });
    const t0 = Date.now();
    await p3.getByRole('button', { name: 'Spin', exact: true }).click();
    await p3.waitForTimeout(1500);
    await p3.screenshot({ path: `${SHOTS}/13-wheel-spinning.png` });
    await Promise.race([
      p3.getByRole('button', { name: 'Spin again' }).waitFor({ timeout: 10000 }),
      p3.getByRole('button', { name: 'Start the questions' }).waitFor({ timeout: 10000 }),
    ]);
    const ms = Date.now() - t0;
    assert.ok(ms >= 4000 && ms <= 7500, `spin took ${ms} ms`);
    await c3.close();
  });

  // Dashboard on a tablet.
  await step('dashboard: sign in, look up, mark as collected once', async () => {
    const c4 = await browser.newContext({ ...devices['iPad (gen 7)'] });
    const p4 = await c4.newPage();
    p4.on('dialog', (d) => d.accept());
    await p4.goto(`${BASE}/challenge/admin/`);
    await p4.getByLabel('Email').fill('manager@example.com');
    await p4.getByLabel('Password').fill('local-test');
    await p4.getByRole('button', { name: 'Sign in' }).click();
    await p4.getByRole('heading', { name: 'Look up a claim code' }).waitFor();
    await p4.getByLabel('Claim code').fill(globalThis.claimCode.toLowerCase());
    await p4.getByRole('button', { name: 'Look up' }).click();
    await p4.getByText('Not collected yet').waitFor();
    await p4.screenshot({ path: `${SHOTS}/14-admin-lookup.png` });
    await p4.getByRole('button', { name: 'Mark as collected' }).click();
    await p4.getByText('Already collected').waitFor();
    await p4.getByRole('button', { name: 'Look up' }).click();
    await p4.getByText('Already collected').waitFor();
    assert.equal(await p4.getByRole('button', { name: 'Mark as collected' }).count(), 0);

    await p4.getByRole('tab', { name: 'Stock and activity' }).click();
    await p4.getByRole('heading', { name: 'Stock' }).waitFor();
    await p4.screenshot({ path: `${SHOTS}/15-admin-stock.png`, fullPage: true });

    await p4.getByRole('tab', { name: 'Controls and exports' }).click();
    await p4.getByRole('button', { name: 'Pause the challenge' }).click();
    await p4.getByRole('button', { name: 'Resume the challenge' }).waitFor();
    await p4.screenshot({ path: `${SHOTS}/16-admin-controls.png`, fullPage: true });
    const dl = p4.waitForEvent('download');
    await p4.getByRole('button', { name: 'Leads (all forms) CSV' }).click();
    const file = await dl;
    const csv = await (await file.createReadStream()).toArray().then((b) => Buffer.concat(b).toString('utf8'));
    assert.match(csv, /lead_source/);
    assert.match(csv, /adipec2026_spin/);
    await p4.getByRole('button', { name: 'Resume the challenge' }).click();
    await p4.getByRole('button', { name: 'Pause the challenge' }).waitFor();
    await c4.close();
  });

  await step('paused challenge shows the closed message to visitors who have not started', async () => {
    await sql(`update spin.config set paused = true`);
    const c5 = await browser.newContext(phone);
    const p5 = await c5.newPage();
    await p5.goto(`${BASE}/challenge/`);
    await p5.getByRole('heading', { name: 'The challenge is closed right now' }).waitFor();
    await p5.screenshot({ path: `${SHOTS}/17-paused.png` });
    await sql(`update spin.config set paused = false`);
    await c5.close();
  });
} finally {
  console.log(results.join('\n'));
  await browser.close();
  await db.end();
}
