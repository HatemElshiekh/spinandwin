// A small stand-in for the Supabase REST API, for browser tests on a laptop or CI without
// network access to Supabase. It runs every RPC as the anon (or authenticated) role against
// a local Postgres that has the migrations applied, exactly like PostgREST would.
//
//   DATABASE_URL=... node tests/local-api.mjs   (listens on :54321)
//
// Sign in with any email from LOCAL_STAFF below and the password "local-test".
import http from 'node:http';
import pg from 'pg';

const url = process.env.DATABASE_URL || 'postgres://postgres@%2Fvar%2Ftmp%2Fpgtest:5433/spintest';
const pool = new pg.Pool({ connectionString: url, max: 50 });
const LOCAL_STAFF = { 'manager@example.com': '00000000-0000-4000-8000-000000000001' };
const PORT = Number(process.env.PORT || 54321);

const send = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/auth/v1/token') {
    const uid = LOCAL_STAFF[body.email];
    if (u.searchParams.get('grant_type') === 'password' && uid && body.password === 'local-test') {
      return send(res, 200, { access_token: `local:${uid}`, refresh_token: `local:${uid}`, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (u.searchParams.get('grant_type') === 'refresh_token') {
      return send(res, 200, { access_token: body.refresh_token, refresh_token: body.refresh_token, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    return send(res, 400, { error_description: 'Invalid login credentials' });
  }

  const m = u.pathname.match(/^\/rest\/v1\/rpc\/(spin_[a-z_]+)$/);
  if (!m) return send(res, 404, { message: 'not found' });
  const auth = req.headers.authorization?.replace(/^Bearer /, '');
  const sub = auth?.startsWith('local:') ? auth.slice(6) : null;
  const names = Object.keys(body);
  const args = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  const values = names.map((n) => (body[n] !== null && typeof body[n] === 'object' ? JSON.stringify(body[n]) : body[n]));
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${sub ? 'authenticated' : 'anon'}`);
    if (sub) await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
    await c.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-forwarded-for': req.socket.remoteAddress })]);
    const r = await c.query(`select public.${m[1]}(${args}) as r`, values);
    await c.query('commit');
    send(res, 200, r.rows[0].r);
  } catch (e) {
    await c.query('rollback').catch(() => {});
    send(res, e.code === '42501' ? 403 : 400, { message: e.message, code: e.code });
  } finally {
    c.release();
  }
}).listen(PORT, () => console.log(`local API on http://localhost:${PORT}`));
