# Gulf Cryo booth challenge (ADIPEC 2026)

Spin and win game for the Gulf Cryo booth at ADIPEC 2026. Visitors scan a QR code, spin a wheel to reserve a gift, answer 4 questions found on the booth walls, fill a short form and show a claim code to a representative.

- Visitor app: `/challenge/`
- Representative dashboard: `/challenge/admin/`
- Brief: [`docs/challenge-brief.md`](docs/challenge-brief.md). Decisions taken after the brief: [`docs/decisions.md`](docs/decisions.md).

## How it is built

| Part | What | Where |
|---|---|---|
| Frontend | Static site, Vite and TypeScript, no framework, no animation library. Visitor bundle about 12 KB gzipped | `challenge/`, `src/` |
| Backend | Postgres functions in Supabase, called over the REST API (`/rest/v1/rpc/spin_*`) | `supabase/migrations/` |
| Hosting | Netlify, built from this repo | `netlify.toml` |

The browser never decides anything. Randomness (`pgcrypto`), prize selection, stock, timers, answer checking and duplicate checks run inside the database functions. All tables live in a private `spin` schema that the API does not expose, with Row Level Security on and no policies. The anon key can only call the `public.spin_*` functions.

### Prize engine in one paragraph

`spin_spin` locks the four gift rows (so spins run one at a time), computes live stock (cumulative daily allocation, minus committed, minus unexpired reservations), and draws with fixed probabilities: spin 1 is 50% "Try again", the other 50% is shared by `chance_weight x daily_allocation` (Seleo 5, others 30 each). Spin 2 has no "Try again". If the drawn gift has no stock left, the visitor goes to the participation gift. A drawn gift is reserved for 10 minutes. Questions run with a server deadline (45 s plus 2 s grace). The form commits the gift and issues a 6 character claim code (no 0, O, 1 or I). Every step is written to the append-only `spin.events` log.

## Environment variables (Netlify and local `.env`)

| Name | Value | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` | Public |
| `VITE_SUPABASE_KEY` | the project's publishable key (`sb_publishable_...`) | Public by design. Never use the service role or secret key here |
| `VITE_DEMO_TOOLS` | `true` on the demo, `false` in production | Shows the demo panel. The database also refuses demo tools unless `spin.config.demo_mode` is on |

## Local development

```sh
npm install
cp .env.example .env   # fill in the demo project URL and publishable key
npm run dev            # http://localhost:5173/challenge/
npm run build          # type check and build into dist/
```

## Database

Migrations are in `supabase/migrations/` and are applied in file name order. They only create the `spin` schema and `public.spin_*` functions; nothing else in the project is touched.

| File | Contents |
|---|---|
| `20261023100000_spin_schema.sql` | Tables, RLS, seed config and gift table |
| `20261023100100_spin_engine.sql` | Prize engine and visitor functions |
| `20261023100200_spin_admin.sql` | Dashboard functions |
| `20261023100300_spin_import_and_demo_settings.sql` | Question import, demo settings and stock tools |
| `20261023100400_spin_demo_reset_tools.sql` | Demo reset tools |

After the migrations on the **demo** project only:

```sql
update spin.config set demo_mode = true, event_start = date '2026-10-23', event_end = date '2026-11-30' where id = 1;
```

Production keeps the defaults (`demo_mode = false`, 2 to 5 November 2026, Asia/Dubai).

### Importing questions

1. Fill the Excel template (Questions tab, every active row must show `OK` in the check column).
2. `npm run questions -- path/to/file.xlsx` writes `supabase/questions-import.sql`. The whole file is rejected with a list of problems if any active row is invalid. Permit words (exclusive, new, for the first time, guarantee) are flagged as warnings.
3. Run the generated SQL on the database (Supabase SQL editor, or ask the developer). Questions that are not active in the file are switched off, never deleted, so old sessions keep their history.

To switch one question off quickly: `update spin.questions set active = false where id = 'Q07';`

### Dashboard accounts

1. Supabase dashboard, Authentication, Users, Add user, Create new user (tick Auto Confirm). Use a strong password.
2. Add the person to the staff list:
   ```sql
   insert into spin.staff (user_id, name, role)
   select id, 'Full Name', 'rep' from auth.users where email = 'person@gulfcryo.com';
   ```
   `role` is `rep` (look up and redeem codes, stock, pause) or `manager` (also add stock and download exports).
3. In Authentication settings, turn off "Allow new users to sign up". Accounts not in `spin.staff` see nothing anyway.

## Deployment

- Netlify builds every push. `netlify.toml` sets `npm run build` and the `dist` folder.
- Demo link: the branch deploy of `feature/challenge`.
- Production: merge to `main` after the demo is approved, with the production Supabase project in the production environment variables.
- **Code freeze from 1 to 5 November.** Nothing is deployed during the show.

### Rollback

- Frontend: Netlify, Deploys, pick the last good deploy, "Publish deploy". Takes seconds.
- Database: migrations only add objects in the `spin` schema. To undo a function change, re-run the previous version of that function from git history. Never drop `spin.entries` or `spin.events`: they hold the leads and the audit log.

## At the booth

- **Pause:** dashboard, "Controls and exports", "Pause the challenge". New visitors see a closed message at once. Visitors already playing can finish.
- **Booth checklist:** pause when the QR stand is removed, resume when it is placed back. Check "Stock and activity" at the start of each day.
- **Handing over a gift:** look up the code, check the name, tap "Mark as collected". A second attempt on the same code is refused.

## Tests

```sh
# local Postgres with the migrations and questions applied, see tests/reset-local.sh
node --test --test-timeout=120000 tests/engine.test.mjs
```

`tests/engine.test.mjs` covers section 16 items 1 to 16 against the database as the anon role: full path, try again, 10,000 spin statistics, out of stock, 200 simultaneous spins for 1 unit, hold expiry, wrong and timeout rules, no repeats, resume, duplicates, double taps, redeem once, day rollover, exports, anon access, pause and validation.

## Known limits

- A visitor can open a private window to get a new device token and spin again before submitting. They must answer the questions again and the duplicate check at the form stops a second win. Representatives check every code on the dashboard.
- Sessions on the same venue Wi-Fi share an IP address; the new session limit is 60 per minute per IP.
- The wheel slices are equal in size but not in chance. The terms say so.
