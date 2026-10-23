// Prize engine tests (brief section 16). Runs against a database that has the migrations
// and the question import applied. Every visitor call runs as the anon role, exactly as
// the browser does; setup and inspection run as the database owner.
//
//   DATABASE_URL=postgres://postgres@localhost:5433/spintest node --test tests/engine.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL || 'postgres://postgres@%2Fvar%2Ftmp%2Fpgtest:5433/spintest';
const pool = new pg.Pool({ connectionString: url, max: 220 });

const sql = async (q, params = []) => (await pool.query(q, params)).rows;

async function as(role, fn, args, sub = null) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    if (sub) await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
    const ph = args.map((_, i) => `$${i + 1}`).join(', ');
    const r = await c.query(`select public.${fn}(${ph}) as r`, args);
    await c.query('commit');
    return r.rows[0].r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
const rpc = (fn, ...args) => as('anon', fn, args);

async function resetAll() {
  await sql(`select public.spin_demo_reset_all()`);
  await sql(`update spin.config set event_start = (now() at time zone 'Asia/Dubai')::date,
             event_end = (now() at time zone 'Asia/Dubai')::date + 3, try_again_share = 0.5,
             rate_limit_per_min = 100000, hold_minutes = 10`);
}

async function newSession() {
  const token = randomUUID() + randomUUID();
  const r = await rpc('spin_start', token, 'test');
  assert.equal(r.ok, true, JSON.stringify(r));
  return { id: r.state.session_id, token, state: r.state };
}

const correctOf = async (qid) => (await sql(`select correct_option from spin.questions where id = $1`, [qid]))[0].correct_option;
const wrongOf = async (qid) => ((await correctOf(qid)) === 'A' ? 'B' : 'A');

// Spins until a gift is reserved (second spin always gives one at full stock).
async function spinToGift(s) {
  let r = await rpc('spin_spin', s.id, s.token, randomUUID());
  if (r.result.outcome === 'try_again') r = await rpc('spin_spin', s.id, s.token, randomUUID());
  assert.equal(r.result.outcome, 'gift', JSON.stringify(r.result));
  return r;
}

async function answer(s, kind) {
  const st = (await rpc('spin_question', s.id, s.token)).state;
  const q = st.question;
  const opt = kind === 'correct' ? await correctOf(q.id) : await wrongOf(q.id);
  return rpc('spin_answer', s.id, s.token, q.id, opt, randomUUID());
}

const form = (n) => ({
  full_name: 'Test Visitor', company: 'Test Co', job_title: 'Engineer',
  email: `visitor${n}@example.com`, phone: `+97150${String(n).padStart(7, '0')}`,
  residence: 'Abu Dhabi', consent_contact: true, consent_marketing: false,
});

before(async () => {
  await sql(`update spin.config set demo_mode = true`);
  await resetAll();
});
after(async () => { await pool.end(); });

test('16.1 full winner path: spin, 4 correct answers, form, claim code', async () => {
  await resetAll();
  const s = await newSession();
  assert.equal(s.state.state, 'ready');
  const spun = await spinToGift(s);
  assert.equal(spun.state.state, 'questions');
  assert.ok(spun.state.gift.name);
  for (let i = 1; i <= 4; i++) {
    const r = await answer(s, 'correct');
    assert.equal(r.result.verdict, 'correct');
    if (i < 4) assert.equal(r.state.question.slot, i + 1);
  }
  const st = (await rpc('spin_state', s.id, s.token)).state;
  assert.equal(st.state, 'form_gift');
  const sub = await rpc('spin_submit', s.id, s.token, form(1), randomUUID());
  assert.equal(sub.state.state, 'done_gift');
  assert.match(sub.state.entry.claim_code, /^[2-9A-HJ-NP-Z]{6}$/);
  assert.equal(sub.state.entry.gift_name, spun.state.gift.name);
});

test('16.2 try again on first spin, guaranteed gift on second spin', async () => {
  await resetAll();
  await sql(`update spin.gifts set total_stock = 100000, daily_allocation = daily_allocation * 1000`);
  let tries = 0;
  for (let i = 0; i < 200; i++) {
    const s = await newSession();
    const r1 = await rpc('spin_spin', s.id, s.token, randomUUID());
    if (r1.result.outcome !== 'try_again') continue;
    tries++;
    assert.equal(r1.state.state, 'spin_again');
    const r2 = await rpc('spin_spin', s.id, s.token, randomUUID());
    assert.equal(r2.result.outcome, 'gift');
    const r3 = await rpc('spin_spin', s.id, s.token, randomUUID());
    assert.equal(r3.error, 'invalid_state', 'no third spin');
  }
  assert.ok(tries > 50, `expected about 100 try agains, got ${tries}`);
});

test('16.3 statistics: 10,000 spins match the fixed probabilities within 1 point', async () => {
  await resetAll();
  const N = 10000;
  const first = { try_again: 0, seleo: 0, mall: 0, entertainment: 0, black_kit: 0 };
  const second = { seleo: 0, mall: 0, entertainment: 0, black_kit: 0 };
  const overall = { seleo: 0, mall: 0, entertainment: 0, black_kit: 0 };
  // 10,000 simulated visitors through spin.draw, the exact function spin_spin uses.
  const rows = await sql(`
    select o1, case when o1 = 'try_again' then (spin.draw(2 + 0 * g)).outcome end as o2
    from (select g, (spin.draw(1 + 0 * g)).outcome as o1 from generate_series(1, $1) g offset 0) t`, [N]);
  for (const r of rows) {
    first[r.o1]++;
    if (r.o2) { second[r.o2]++; overall[r.o2]++; } else overall[r.o1]++;
  }
  const pct = (o, n) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +(100 * v / n).toFixed(2)]));
  const exp1 = { try_again: 50, seleo: 2.63, mall: 15.79, entertainment: 15.79, black_kit: 15.79 };
  const exp2 = { seleo: 5.26, mall: 31.58, entertainment: 31.58, black_kit: 31.58 };
  const p1 = pct(first, N);
  const n2 = Object.values(second).reduce((a, b) => a + b, 0);
  const p2 = pct(second, n2);
  const pAll = pct(overall, N);
  console.log('first spin %', p1, '\nsecond spin % (n=' + n2 + ')', p2, '\noverall %', pAll);
  for (const k in exp1) assert.ok(Math.abs(p1[k] - exp1[k]) < 1, `first spin ${k}: ${p1[k]} vs ${exp1[k]}`);
  for (const k in exp2) assert.ok(Math.abs(pAll[k] - exp2[k]) < 1, `overall ${k}: ${pAll[k]} vs ${exp2[k]}`);
  // Second spin sample is about 5,000, so allow the wider 1.5 point band there.
  for (const k in exp2) assert.ok(Math.abs(p2[k] - exp2[k]) < 1.5, `second spin ${k}: ${p2[k]} vs ${exp2[k]}`);
  assert.ok(pAll.seleo < Math.min(pAll.mall, pAll.entertainment, pAll.black_kit), 'Seleo is the rarest');
});

test('16.4 out of stock gift is never given; all out of stock blocks spinning', async () => {
  await resetAll();
  await sql(`select public.spin_demo_seed_stock('mall', 0, 0)`);
  // Shares are fixed, so mall draws still happen, but they must end on the participation gift.
  await sql(`update spin.gifts set daily_allocation = 10 where id = 'mall'`); // share back to 30, stock 0
  let noStock = 0;
  for (let i = 0; i < 150; i++) {
    const s = await newSession();
    let r = await rpc('spin_spin', s.id, s.token, randomUUID());
    if (r.result.outcome === 'try_again') r = await rpc('spin_spin', s.id, s.token, randomUUID());
    if (r.result.outcome === 'no_stock') {
      noStock++;
      assert.equal(r.state.state, 'form_participation');
      assert.equal(r.state.end_reason, 'no_stock');
    } else {
      assert.notEqual(r.result.gift_id, 'mall');
    }
    await sql(`update spin.sessions set reservation_status = 'released' where id = $1`, [s.id]);
  }
  assert.ok(noStock > 0, 'some mall draws happened');
  const [{ n }] = await sql(`select count(*)::int n from spin.sessions where reserved_gift_id = 'mall'`);
  assert.equal(n, 0);

  for (const g of ['seleo', 'mall', 'entertainment', 'black_kit']) await sql(`select public.spin_demo_seed_stock($1, 0, 0)`, [g]);
  const s = await newSession();
  assert.equal(s.state.all_claimed, true);
  const r = await rpc('spin_spin', s.id, s.token, randomUUID());
  assert.equal(r.result.outcome, 'all_claimed');
  assert.equal(r.state.state, 'form_participation');
});

test('16.5 concurrency: 1 unit left and 200 simultaneous spins give it to exactly one', async () => {
  await resetAll();
  await sql(`update spin.config set try_again_share = 0`);
  for (const g of ['mall', 'entertainment', 'black_kit']) await sql(`select public.spin_demo_seed_stock($1, 0, 0)`, [g]);
  await sql(`select public.spin_demo_seed_stock('seleo', 1, 1)`);
  const sessions = await Promise.all(Array.from({ length: 200 }, newSession));
  const results = await Promise.all(sessions.map((s) => rpc('spin_spin', s.id, s.token, randomUUID())));
  const winners = results.filter((r) => r.result.outcome === 'gift');
  assert.equal(winners.length, 1, `winners: ${winners.length}`);
  // Everyone else lands on the participation gift: either their drawn gift had no unit
  // left, or every gift was already gone by the time their spin ran.
  const others = results.filter((r) => r.result.outcome !== 'gift');
  assert.equal(others.length, 199);
  for (const r of others) {
    assert.ok(['no_stock', 'all_claimed'].includes(r.result.outcome), r.result.outcome);
    assert.equal(r.state.state, 'form_participation');
  }
  const [st] = await sql(`select * from spin.stock() where gift_id = 'seleo'`);
  assert.equal(st.reserved, 1);
  assert.equal(st.available, 0);
  const [{ neg }] = await sql(`select count(*)::int neg from spin.stock() where allocation - committed - reserved < 0`);
  assert.equal(neg, 0);
});

test('16.6 reservation expires after the hold time and stock returns', async () => {
  await resetAll();
  const s = await newSession();
  const r = await spinToGift(s);
  const gift = r.state.gift.id;
  const before = (await sql(`select available from spin.stock() where gift_id = $1`, [gift]))[0].available;
  await sql(`update spin.sessions set reservation_expires_at = now() - interval '1 second' where id = $1`, [s.id]);
  const after = (await sql(`select available from spin.stock() where gift_id = $1`, [gift]))[0].available;
  assert.equal(after, before + 1, 'expired reservation no longer counts');
  const st = (await rpc('spin_state', s.id, s.token)).state;
  assert.equal(st.state, 'form_participation');
  assert.equal(st.end_reason, 'expired');
});

test('16.7 wrong then correct, wrong twice, third wrong and timeout', async () => {
  await resetAll();
  // Wrong then correct on the same slot: a replacement appears, then the next slot.
  let s = await newSession();
  await spinToGift(s);
  let r = await answer(s, 'wrong');
  assert.equal(r.result.verdict, 'wrong');
  assert.equal(r.state.state, 'questions');
  assert.equal(r.state.question.slot, 1);
  assert.equal(r.state.question.attempt, 2);
  r = await answer(s, 'correct');
  assert.equal(r.state.question.slot, 2);

  // Wrong on the replacement question: game over, reservation released.
  r = await answer(s, 'wrong');
  r = await answer(s, 'wrong');
  assert.equal(r.state.state, 'form_participation');
  assert.equal(r.state.end_reason, 'wrong_twice');
  const [row] = await sql(`select reservation_status from spin.sessions where id = $1`, [s.id]);
  assert.equal(row.reservation_status, 'released');

  // Hatem's example: wrong Q1 then right, wrong Q2 then right, wrong Q3 ends the game.
  s = await newSession();
  await spinToGift(s);
  await answer(s, 'wrong'); await answer(s, 'correct');
  await answer(s, 'wrong'); await answer(s, 'correct');
  r = await answer(s, 'wrong');
  assert.equal(r.state.state, 'form_participation');
  assert.equal(r.state.end_reason, 'too_many_wrong');

  // Timeout: no replacement, game over once the server deadline plus grace has passed.
  s = await newSession();
  await spinToGift(s);
  const q = (await rpc('spin_question', s.id, s.token)).state.question;
  await sql(`update spin.session_questions set deadline = now() - interval '3 seconds' where session_id = $1 and result is null`, [s.id]);
  r = await rpc('spin_answer', s.id, s.token, q.id, await correctOf(q.id), randomUUID());
  assert.equal(r.result.verdict, 'timeout');
  assert.equal(r.state.state, 'form_participation');
  assert.equal(r.state.end_reason, 'timeout');
});

test('16.15 timer: 44 s answers count, 45 s plus grace ends the game, within grace still counts', async () => {
  await resetAll();
  let s = await newSession();
  await spinToGift(s);
  let q = (await rpc('spin_question', s.id, s.token)).state.question;
  assert.ok(q.remaining_ms > 44000 && q.remaining_ms <= 45000, `remaining ${q.remaining_ms}`);
  // Answer arriving at 44 s.
  await sql(`update spin.session_questions set deadline = now() + interval '1 second' where session_id = $1 and result is null`, [s.id]);
  let r = await rpc('spin_answer', s.id, s.token, q.id, await correctOf(q.id), randomUUID());
  assert.equal(r.result.verdict, 'correct');
  // Answer arriving 1 s after the deadline (network latency) is inside the 2 s grace.
  q = r.state.question;
  await sql(`update spin.session_questions set deadline = now() - interval '1 second' where session_id = $1 and result is null`, [s.id]);
  r = await rpc('spin_answer', s.id, s.token, q.id, await correctOf(q.id), randomUUID());
  assert.equal(r.result.verdict, 'correct');
  // Nothing sent: the state check after the deadline plus grace ends the game.
  await sql(`update spin.session_questions set deadline = now() - interval '2.5 seconds' where session_id = $1 and result is null`, [s.id]);
  const st = (await rpc('spin_state', s.id, s.token)).state;
  assert.equal(st.state, 'form_participation');
  assert.equal(st.end_reason, 'timeout');
});

test('16.8 no question repeats within a session, and walls alternate where possible', async () => {
  await resetAll();
  const s = await newSession();
  await spinToGift(s);
  await answer(s, 'wrong'); await answer(s, 'correct');
  await answer(s, 'wrong'); await answer(s, 'correct');
  await answer(s, 'correct'); await answer(s, 'correct');
  const rows = await sql(`select sq.question_id, q.wall from spin.session_questions sq join spin.questions q on q.id = sq.question_id
                          where session_id = $1 order by sq.id`, [s.id]);
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((r) => r.question_id)).size, 6);
  for (let i = 1; i < rows.length; i++) assert.notEqual(rows[i].wall, rows[i - 1].wall, 'consecutive walls differ');
});

test('16.8b the correct answer is never sent to the browser', async () => {
  await resetAll();
  const s = await newSession();
  await spinToGift(s);
  const st = await rpc('spin_question', s.id, s.token);
  const text = JSON.stringify(st);
  assert.ok(!/correct/i.test(text), 'no correct field in the question payload');
});

test('16.9 refresh resumes at the same step', async () => {
  await resetAll();
  const s = await newSession();
  const spun = await spinToGift(s);
  const q1 = (await rpc('spin_question', s.id, s.token)).state.question;
  const again = await rpc('spin_start', s.token, 'test');
  assert.equal(again.state.session_id, s.id);
  assert.equal(again.state.state, 'questions');
  assert.equal(again.state.question.id, q1.id);
  assert.deepEqual(again.state.question.options.map((o) => o.id), q1.options.map((o) => o.id), 'same option order');
  assert.equal(again.state.gift.id, spun.state.gift.id);
});

test('16.10 duplicate email and duplicate phone both give "already played" and release the gift', async () => {
  await resetAll();
  const play = async () => { const s = await newSession(); await spinToGift(s); for (let i = 0; i < 4; i++) await answer(s, 'correct'); return s; };
  const a = await play();
  await rpc('spin_submit', a.id, a.token, form(10), randomUUID());

  const b = await play();
  const sameEmail = { ...form(11), email: '  VISITOR10@Example.com ' };
  let r = await rpc('spin_submit', b.id, b.token, sameEmail, randomUUID());
  assert.equal(r.state.state, 'already_played');
  let [row] = await sql(`select reservation_status from spin.sessions where id = $1`, [b.id]);
  assert.equal(row.reservation_status, 'released');

  const c = await play();
  const samePhone = { ...form(12), phone: '00971 50 000 0010' };
  r = await rpc('spin_submit', c.id, c.token, samePhone, randomUUID());
  assert.equal(r.state.state, 'already_played');

  // A participation gift also counts as having played.
  const d = await newSession();
  await spinToGift(d);
  await answer(d, 'wrong'); await answer(d, 'wrong');
  await rpc('spin_submit', d.id, d.token, form(20), randomUUID());
  const e = await play();
  r = await rpc('spin_submit', e.id, e.token, form(20), randomUUID());
  assert.equal(r.state.state, 'already_played');
});

test('16.11 double taps on spin, answer and submit never create duplicates', async () => {
  await resetAll();
  const s = await newSession();
  const key = randomUUID();
  const [a, b] = await Promise.all([rpc('spin_spin', s.id, s.token, key), rpc('spin_spin', s.id, s.token, key)]);
  assert.deepEqual(a.result, b.result);
  const [{ n }] = await sql(`select count(*)::int n from spin.events where session_id = $1 and type = 'spin'`, [s.id]);
  assert.equal(n, 1);
  if (a.result.outcome === 'try_again') await rpc('spin_spin', s.id, s.token, randomUUID());

  const q = (await rpc('spin_question', s.id, s.token)).state.question;
  const k2 = randomUUID();
  const opt = await correctOf(q.id);
  const [x, y] = await Promise.all([rpc('spin_answer', s.id, s.token, q.id, opt, k2), rpc('spin_answer', s.id, s.token, q.id, opt, k2)]);
  assert.deepEqual(x, y);
  for (let i = 0; i < 3; i++) await answer(s, 'correct');

  const k3 = randomUUID();
  const [p, r] = await Promise.all([rpc('spin_submit', s.id, s.token, form(30), k3), rpc('spin_submit', s.id, s.token, form(30), k3)]);
  assert.deepEqual(p, r);
  const [{ m }] = await sql(`select count(*)::int m from spin.entries where session_id = $1`, [s.id]);
  assert.equal(m, 1);
});

test('16.12 claim code redeems once; second redemption is rejected', async () => {
  await resetAll();
  const uid = randomUUID();
  await sql(`insert into spin.staff (user_id, name, role) values ($1, 'Rep One', 'manager') on conflict do nothing`, [uid]);
  const s = await newSession();
  await spinToGift(s);
  for (let i = 0; i < 4; i++) await answer(s, 'correct');
  const sub = await rpc('spin_submit', s.id, s.token, form(40), randomUUID());
  const code = sub.state.entry.claim_code;
  const look = await as('authenticated', 'spin_admin_lookup', [code.toLowerCase()], uid);
  assert.equal(look.ok, true);
  const r1 = await as('authenticated', 'spin_admin_redeem', [code], uid);
  assert.equal(r1.ok, true);
  assert.equal(r1.entry.collected_by_name, 'Rep One');
  const r2 = await as('authenticated', 'spin_admin_redeem', [code], uid);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'already_collected');
});

test('16.13 day rollover adds the daily allocation and carries unused stock over', async () => {
  await resetAll();
  const alloc = async () => Object.fromEntries((await sql(`select gift_id, allocation from spin.stock()`)).map((r) => [r.gift_id, r.allocation]));
  await sql(`select public.spin_demo_settings(1, null)`);
  assert.deepEqual(await alloc(), { seleo: 5, mall: 10, entertainment: 10, black_kit: 5 });
  await sql(`select public.spin_demo_settings(2, null)`);
  assert.deepEqual(await alloc(), { seleo: 10, mall: 20, entertainment: 20, black_kit: 10 });
  await sql(`select public.spin_demo_settings(5, null)`);
  assert.deepEqual(await alloc(), { seleo: 20, mall: 40, entertainment: 40, black_kit: 20 }, 'capped at total stock');
  await sql(`select public.spin_demo_settings(0, null)`);
  // Real clock: midnight GST is the boundary.
  const [{ d }] = await sql(`select spin.event_day(c) d from spin.config c`);
  assert.equal(d, 1);
});

test('16.13b stock added from the dashboard counts from today', async () => {
  await resetAll();
  const uid = randomUUID();
  await sql(`insert into spin.staff (user_id, name, role) values ($1, 'Manager', 'manager')`, [uid]);
  const rep = randomUUID();
  await sql(`insert into spin.staff (user_id, name, role) values ($1, 'Rep', 'rep')`, [rep]);
  await assert.rejects(as('authenticated', 'spin_admin_add_stock', ['seleo', 3, null], rep), /not_authorized/);
  const r = await as('authenticated', 'spin_admin_add_stock', ['seleo', 3, 'extra boxes'], uid);
  assert.equal(r.ok, true);
  const [st] = await sql(`select allocation from spin.stock() where gift_id = 'seleo'`);
  assert.equal(st.allocation, 8);
});

test('16.14 exports return the expected rows and columns', async () => {
  await resetAll();
  const uid = randomUUID();
  await sql(`insert into spin.staff (user_id, name, role) values ($1, 'Manager', 'manager')`, [uid]);
  const s = await newSession();
  await spinToGift(s);
  for (let i = 0; i < 4; i++) await answer(s, 'correct');
  await rpc('spin_submit', s.id, s.token, form(50), randomUUID());
  const p = await newSession();
  await spinToGift(p);
  await answer(p, 'wrong'); await answer(p, 'wrong');
  await rpc('spin_submit', p.id, p.token, form(51), randomUUID());

  const leads = await as('authenticated', 'spin_admin_export', ['leads'], uid);
  assert.equal(leads.length, 2);
  assert.equal(leads[0].lead_source, 'adipec2026_spin');
  assert.deepEqual(leads.map((l) => l.entry_type).sort(), ['gift', 'participation']);
  const winners = await as('authenticated', 'spin_admin_export', ['winners'], uid);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].residence, 'Abu Dhabi');
  const unclaimed = await as('authenticated', 'spin_admin_export', ['unclaimed'], uid);
  assert.equal(unclaimed.length, 1);
});

test('16.16 the anon role cannot read or write any table, or call admin and internal functions', async () => {
  const c = await pool.connect();
  try {
    for (const t of ['config', 'gifts', 'questions', 'sessions', 'entries', 'events', 'staff']) {
      await c.query('begin; set local role anon');
      await assert.rejects(c.query(`select * from spin.${t} limit 1`), /permission denied/);
      await c.query('rollback');
    }
    await c.query('begin; set local role anon');
    await assert.rejects(c.query(`insert into spin.entries (session_id) values (gen_random_uuid())`), /permission denied/);
    await c.query('rollback');
    for (const f of ['spin_admin_overview()', "spin_admin_export('leads')", "spin_admin_redeem('AAAAAA')"]) {
      await c.query('begin; set local role anon');
      await assert.rejects(c.query(`select public.${f}`), /permission denied/);
      await c.query('rollback');
    }
    await c.query('begin; set local role anon');
    await assert.rejects(c.query(`select spin.rand()`), /permission denied/);
    await c.query('rollback');
    // Signed in but not on the staff list.
    await c.query('begin; set local role authenticated');
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [randomUUID()]);
    await assert.rejects(c.query(`select public.spin_admin_overview()`), /not_authorized/);
    await c.query('rollback');
  } finally {
    c.release();
  }
});

test('demo tools refuse to run when demo mode is off', async () => {
  await sql(`update spin.config set demo_mode = false`);
  try {
    await assert.rejects(rpc('spin_demo_reset_all'), /demo tools are disabled/);
    await assert.rejects(rpc('spin_demo_settings', 3, 10), /demo tools are disabled/);
  } finally {
    await sql(`update spin.config set demo_mode = true`);
  }
});

test('pause stops new sessions and first spins, active sessions can finish', async () => {
  await resetAll();
  const s = await newSession();
  const t = await newSession();
  const r = await spinToGift(t);
  await sql(`update spin.config set paused = true`);
  try {
    const fresh = await rpc('spin_start', randomUUID() + randomUUID(), null);
    assert.equal(fresh.state.state, 'paused');
    const spin = await rpc('spin_spin', s.id, s.token, randomUUID());
    assert.equal(spin.error, 'paused');
    const ans = await answer(t, 'correct');
    assert.equal(ans.result.verdict, 'correct', 'a visitor already playing can continue');
    assert.ok(r);
  } finally {
    await sql(`update spin.config set paused = false`);
  }
});

test('form validation rejects bad input with field errors', async () => {
  await resetAll();
  const s = await newSession();
  await spinToGift(s);
  for (let i = 0; i < 4; i++) await answer(s, 'correct');
  const r = await rpc('spin_submit', s.id, s.token, { full_name: 'A', email: 'nope', phone: '12', consent_contact: false }, randomUUID());
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.fields).sort(), ['company', 'consent_contact', 'email', 'full_name', 'phone', 'residence']);
  assert.equal(r.state.state, 'form_gift');
});
