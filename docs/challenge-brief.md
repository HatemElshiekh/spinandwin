# ADIPEC 2026 spin and win: build brief

> Original brief from Hatem, 23 October 2026. Decisions taken after this brief are in `decisions.md`, which takes precedence.

This brief is for the Claude instance that will design and build the Gulf Cryo spin and win booth game. It contains the full context, every decision made so far, the open decisions, and the engineering bar the build must meet.

## 0. How to work on this project

You are the lead engineer on this build, not a code generator. Read the whole brief before writing any code.

1. **Think before you build.** If a rule in this brief is ambiguous, contradictory, unsafe for a live event, or technically weak, say so and propose a fix. Do not silently follow it and do not silently change it.
2. **Never guess an open decision.** Section 5 lists decisions that are not made yet. Build each one as a configuration value with the stated default, and list it in your handover as "needs confirmation".
3. **Never invent content.** Questions, gift names, values and quantities come from Hatem. If something is missing, use a clearly marked placeholder and flag it.
4. **The server is the only source of truth.** Randomness, prize selection, stock, timers, answer checking and duplicate checks happen on the server. The browser only displays results.
5. **Do not break what already exists.** There is a live landing page on the same domain. Read the existing code before touching anything.
6. **Report honestly.** If you cannot deploy, cannot access the repo, or cannot test something, say exactly what is missing. Do not claim something works unless you tested it.
7. **No em dashes** anywhere: not in code comments, UI copy, docs or messages.

### Design rules

Colors

* Never use an indigo/violet to blue gradient anywhere. The only blue is Navy `#365888`, used flat
* Never use Tailwind's default palette. Use only the brand tokens: Navy `#365888`, Black `#000`, Grey `#909496`, Dark Grey `#5B5E61`, Light Grey `#E7EBEF`, White
* Never use gradient text (`bg-clip-text`) on headings. Headings are solid Navy or Black
* Never use green or red as decoration. They appear only as answer feedback, and never by color alone (always paired with an icon or text)
* Never default to a dark gray-900 / slate-950 theme. The game is light and high-contrast for bright exhibition light

Layout

* Never create a marketing hero with a badge + big headline + two buttons. Each screen has one job (welcome, spin, question, form, claim code) and one primary action
* Never create a 3-column feature grid, bento grid, or any desktop-grid section. This is a single-column mobile-first flow
* Never create a `max-w-7xl` centered desktop container. Constrain to a phone width (`max-w-md`) and design for the thumb
* Never create a bottom CTA section, a pricing section, or a multi-column footer. None of these screens exist in the flow (section 6)

Prebuilt components

* Never create pricing cards, testimonial cards, a "Trusted by" logo strip, or a stats row with inflated numbers. None belong in a booth game
* Never create an FAQ accordion. Terms are short on the welcome screen with full terms one tap away
* Never invent gift names, values, counts, questions, or answers in the UI. All of these come from config and the question bank, with clearly marked placeholders if missing

Styling and effects

* Never use oversized radius (`rounded-2xl` / `rounded-3xl`) everywhere. Keep radii modest and consistent with an industrial, precise feel
* Never use glassmorphism or `backdrop-blur` cards. Use solid surfaces (White on Light Grey) with clear separation
* Never use blurred gradient blobs or mesh backgrounds. Backgrounds are flat brand colors
* Never use `shadow-xl` cards that lift on hover. This is a touch interface with no hover, and the tone is restrained; use subtle borders or light shadows only where needed for tap targets
* Never use a fixed blurred navbar. The persistent element is the progress bar (section 4.9), not a nav
* Never add a heavy animation library (Framer Motion, GSAP, Lottie). The wheel is SVG or canvas with CSS transforms, and every motion respects `prefers-reduced-motion`
* Never add confetti, loud effects, or exclamation-heavy motion on the celebration screen. The celebration is short and controlled (section 6.5)

Typography and icons

* Never default to Inter. Use Museo Sans if a licensed web font is confirmed by Hatem, otherwise a clean system fallback such as Segoe UI, and never load a font without asking first
* Never put icons inside colored rounded squares. Icons stay minimal and monochrome in the brand greys
* Never use emojis anywhere, including buttons, feedback, and the claim screen

Copy

* Never use generic marketing headlines ("Empower your workflow", "Seamless experience", "unlock", "amazing", "lucky you"). Tone is confident, short, mature, industrial
* Never use the permit-forbidden words: "exclusive", "new", "for the first time", or any guarantee claim
* Never rephrase the approved winner line. Use it verbatim: "Your gift is ready. Show this screen to a Gulf Cryo representative to collect it."
* Never use em dashes in any UI copy, comment, or doc
* Never write a vague product-style blurb. Every screen states plainly what to do next (spin, find the answers on the walls, fill the form, show the code)

## 0.1 Your working environment

You are running in **Claude Code** on Hatem's machine, with access to the Git repository behind the Netlify site. Hatem is not a developer. That shapes how you work:

- **Explain before acting.** Before any command that changes something outside your working branch (pushing, merging, running SQL on the database, changing Netlify settings), state in one or two plain sentences what it does and wait for Hatem's yes.
- **Branch discipline.** Work on a branch named `feature/challenge`. Never commit directly to the production branch. Merging to production happens only after Hatem approves the demo.
- **Secrets.** Never commit keys. Use environment variables or an untracked `.env` file. The Supabase service role key never goes into frontend code or the repository.
- **Supabase access.** At the start, check whether you can reach Supabase (Supabase MCP server or the Supabase CLI with an access token). If not, tell Hatem exactly what to set up, step by step. All database changes go through versioned migration files in the repo, applied first to the demo schema, then to production only with Hatem's approval.
- **Netlify.** Check whether the site is linked to this repository. If it is, a pushed branch produces a Netlify deploy preview or branch deploy, which is the public demo link. If the site turns out to be deployed manually, stop and walk Hatem through linking the repo to Netlify before anything else. Never trigger a production deploy without approval.
- **Test before you report.** Run the app locally and run the acceptance tests in section 16 yourself. Report results with evidence (test output), not assumptions.

**Architecture:**
- **Frontend:** a route at `/challenge` inside the existing site. Follow the existing framework if it is reasonable; if adding it to the framework risks the landing page, use a self-contained static folder served at `/challenge` instead and explain why. The landing page must keep working exactly as before.
- **Backend:** all game logic in Supabase (Postgres functions called through RPC, Row Level Security). Avoid Netlify Functions unless there is a clear reason, so the game does not depend on the landing page's build.
- **Config:** Supabase URL, anon key and schema name come from environment variables per environment (demo and production).

## 1. Project summary

Gulf Cryo is exhibiting at ADIPEC 2026 at ADNEC, Abu Dhabi, from 2 to 5 November 2026. At the booth, visitors scan a QR code with their own phone and play a short challenge:

1. They spin a wheel and win a gift, which is reserved for them.
2. To unlock the gift, they answer 4 questions. The answers are printed on the booth walls (map, timeline, and so on), so visitors have to explore the booth.
3. If they complete the questions, they submit a short form and receive a claim code, which they show to a Gulf Cryo representative to collect the gift.
4. If they fail, they still register and receive a free coffee.

The game is a lead capture and engagement tool. Every completed form, winner or coffee, is a lead.

**The deliverable has two stages:**
- **Stage 1, demo:** a fully working version on a public link (not localhost), with 25 test questions, attached in excel sheet, used by the team for testing and review.
- **Stage 2, production:** the same code, hardened, with the full question bank (25 to 35 questions) and real stock, running at `adipec2026.gulfcryo.com` during the show.

**The bar for production:** hundreds of visitors, on congested exhibition mobile networks, in a high-visibility environment where nobody can fix bugs on the spot. Treat it like a payment flow: no overselling stock, no double prizes, no lost leads, no crash that blocks the booth.

## 2. Context

### 2.1 Company
Gulf Cryo is an industrial gases company founded in Kuwait in 1953, operating across 10 countries in MENAT. The brand voice is senior, industrial and precise. It must never sound playful, cheap or overly promotional, even inside a game.

### 2.2 Existing stack
- A newly created project on **Netlify + Supabase** and a repository on github named spinandwin - Public

## 4. Locked decisions

These were decided by Hatem. Implement them exactly. If you believe one is wrong, raise it in your handover, but build it as specified.

### 4.1 Order of the experience
The gift is revealed first (spin), then the questions. This is intentional: the reserved gift motivates visitors to finish. Do not reorder.

### 4.2 Gifts

| Order (rarest first) | Gift | Value (AED) | Total stock | Chance weight | Daily allocation |
|---|---|---|---|---|---|
| 1 | Seleo Machine | 300 | 20 | 1 | 5 |
| 2 | Mall Voucher | 150 | 40 | 3 | 10 |
| 3 | Entertainment Voucher | 150 | 40 | 3 | 10 |
| 4 | Black Kit | 50 | 20 | 6 | 5 |
| | **Total** | | **120** | | **30 per day** |

Chance weights and daily allocations are locked for the event. They must live in the database as configuration, not hardcoded, but there is no editing UI for them.

### 4.3 The wheel
- 10 slices: each of the 4 gifts appears on 2 slices, plus 2 "try again" slices.
- All 10 slices are always visible, even when a gift is out of stock. The visual layout never changes.
- The server decides the outcome first. The client then animates the wheel to land on one of the matching slices (pick one of the two at random).
- Slice size does not represent probability. That is acceptable, but the terms must not claim equal odds.

### 4.4 Spin probabilities
- **Weight of a gift** = chance weight × available stock right now (see 4.5 for "available").
- **First spin:** "try again" = 50%. The remaining 50% is shared between gifts in proportion to their weights.
- **Second spin** (only after a first-spin "try again"): "try again" = 0%. 100% is shared between gifts by weight. The visitor always wins on the second spin.
- A gift with zero available stock has zero weight, so it can never be selected.
- If all gifts have zero available stock, the visitor must not be allowed to spin. Show the "gifts for today are all claimed" state (see 6.1).

**Worked example (full daily stock: 5, 10, 10, 5):**
- Weights: Seleo 1 × 5 = 5, Mall 3 × 10 = 30, Entertainment 3 × 10 = 30, Black Kit 6 × 5 = 30. Total 95.
- First spin: Seleo 2.6%, Mall 15.8%, Entertainment 15.8%, Black Kit 15.8%, try again 50%.
- Second spin: Seleo 5.3%, Mall 31.6%, Entertainment 31.6%, Black Kit 31.6%.
- Overall per visitor (both spins combined): Seleo 5.3%, each other gift 31.6%.

Use a cryptographically secure random source on the server.

### 4.5 Stock, reservation and daily allocation
- **Days** follow Gulf Standard Time (Asia/Dubai, UTC+4). Day 1 is 2 November 2026.
- **Cumulative allocation:** on day N, the allocation for a gift is its daily allocation × N, capped at total stock. Unused stock from earlier days automatically carries over.
- **Available stock** = cumulative allocation − committed − active reservations.
- **Reservation:** when a spin selects a gift, one unit is reserved for that session. The reservation holds for **20 minutes** from the spin.
- **Release:** the reservation is released back to stock when:
  - the session hits game over (wrong twice or timeout),
  - the form is rejected as a duplicate ("you already won"),
  - the 20 minutes expire without a submitted form.
- **Commit:** the gift is deducted permanently when the winner form is submitted successfully. A claim code is issued at that moment.
- **Handover:** a representative marks the claim code as collected. Committed but not collected prizes are "unclaimed" for the Red Crescent report.
- Selection, reservation, release and commit must be atomic (database transaction with row locks, or equivalent). Two visitors spinning at the same millisecond must never receive the last unit of the same gift.
- Expired reservations must be released lazily inside every stock calculation (treat expired as released), not only by a scheduled job.

### 4.6 Questions
- Each visitor must answer 4 questions correctly to unlock the gift.
- The answers are on the booth walls. Each question has a button called "Hint" when clicked shows a hint pointing to a wall, written indirectly (not "check the timeline wall").
- **One wrong answer allowed per question:** a wrong answer turns the selected button red, shows "Wrong answer, try again", and replaces the question with a different one from the bank. This is allowed to happen 2 times only for each user
- A note on every question screen tells the visitor that one wrong answer is allowed for that question.
- **Correct answer:** the selected button turns green, then the next question appears.
- **Timer:** 45 seconds per question, enforced by the server. If it runs out, the game ends immediately (game over) then below it (please complete the form to collect your gift for particiapating"or similar"). A timeout does not give a replacement question.
- **Question counter:** "Question 1 of 4" style counter on every question screen.
- No question repeats within a session.
- For testing, Hatem will provide **25 questions**. The production bank will be 25 to 35 questions, added after testing.

### 4.7 Duplicate rule
- One completed submission per person, whether gift or coffee. A visitor who received a coffee cannot play again with the same email or phone. The check happens at form submission using normalized email or normalized phone.
- If the email or phone already has a committed win, show the "You already won" screen: tell them they already won a gift and that the game is available once per submission. Release their reservation.

### 4.8 Game over
- Triggered by: wrong answer on a replacement question, or timer running out.
- The reserved gift is released immediately.

### 4.9 Progress
- A progress bar is visible on every screen of the experience, from welcome to the final screen.

### 4.10 Language
The visitor UI and all questions are in English only.

### 4.12 Approved copy (use verbatim, do not rephrase)
Final winner screen: "Your gift is ready. Show this screen to a Gulf Cryo representative to collect it."

## 5. Open decisions (build as config, flag in handover)

### Decisions already confirmed (do not reopen)
- Timer: 45 seconds per question.
- Timeout: game over directly, no replacement question.
- Coffee recipients cannot play again with the same email or phone.
- Questions and UI: English only.
- No fixed hours: the pause switch controls availability.

## 6. Screen by screen flow

All screens: mobile first, English only, progress bar, Gulf Cryo branding.

### 6.1 Entry (QR lands here)
- URL: `/challenge` (production) with an optional `?src=` tag for tracking.
- On load, the app calls the server to create or resume a session (see 9.2).
- Possible states before the welcome screen:
  - **Game paused** (pause switch on, or event not live): short message, no spin.
  - **All gifts for today claimed:** message plus offer to register for participation gift.
  - **Session in progress:** resume exactly where the visitor left off.

### 6.2 Welcome
- One line on what to expect: spin, answer 4 questions found around the booth, collect the gift.
- Short terms: one game per person; one wrong answer allowed per question; 45 seconds per question, and running out of time ends the game; gifts collected at the booth only; while stock lasts.
- Link to full terms.
- Button: "Spin the wheel".

### 6.3 Spin
- Wheel with 10 slices. Tapping spin calls the server, which returns the outcome. The animation runs 4 to 6 seconds and lands on a matching slice.
- If the outcome is "try again": message, then second spin (guaranteed gift).
- If the outcome is a gift: show the gift and a short line that it is reserved for them while they complete the challenge.
- Respect `prefers-reduced-motion`.
- Double taps must not trigger two spins (disable button and use an idempotency key).

### 6.4 Questions (4 correct answers required)
- Counter "Question X of 4", 45 second countdown, hint, note "One wrong answer is allowed for this question. If time runs out, the game ends."
- Four answer buttons. On tap: lock all buttons, send answer to the server, then color the selected button green or red based on the server's verdict.
- Correct: short pause, next question.
- First wrong: red, "Wrong answer, try again", replacement question.
- Second wrong on the same slot, or timeout on any question: game over.
- The correct answer must never be sent to the browser before the visitor answers.

### 6.5 Celebration
- Short, controlled celebration (no loud effects). Then the form.

### 6.6 Form
Fields:
- Full name (required)
- Company (required)
- Job title (optional)
- Email (required, validated)
- Mobile with country code (required, normalized to E.164)
- Visitor type (required, see 5.2)
- Emirate or country of residence (required, for the permit)
- Consent checkbox (required): use of data to contact them about Gulf Cryo and to administer the promotion. Must not be pre-ticked.
- Optional second checkbox for marketing communications, if Hatem wants it.

On submit, the server checks duplicates (4.7) and either commits the gift or returns the "already won" state.

### 6.7 Final screen (winner)
- Approved copy from 4.12, verbatim.
- Gift name and a large claim code (short, unambiguous characters, for example 6 characters without 0/O/1/I).
- The screen must be re-openable if the visitor closes the browser (resume via session token).

### 6.8 Final screen (participation gift)
- Same structure: participation gift, shown to the representative.

### 6.9 Already won
- Message that this email or phone has already won, and the game is available once per submission.

## 7. Prize engine (server functions)

Implement as Postgres functions (Supabase RPC) or Supabase Edge Functions. Each must be idempotent and transactional.

- `start_session(device_token, src)` returns session id and current state. Resumes an active session for the same device token.
- `spin(session_id, idempotency_key)`:
  - Validates session state and spin number (1 or 2).
  - Locks gift inventory rows, calculates available stock (cumulative allocation − committed − unexpired reservations).
  - Applies 4.4 probabilities. Reserves one unit if a gift is selected.
  - Returns outcome and, if a gift, the reservation expiry time.
- `get_question(session_id)` returns the next unseen question without the correct answer, and sets a server-side deadline.
- `answer(session_id, question_id, option_id, idempotency_key)` checks the deadline (allow a small grace for latency, for example 2 seconds), checks the answer, updates state, returns verdict and next state.
- `submit_form(session_id, payload, idempotency_key)` normalizes contact data, checks duplicates, commits or releases, issues claim code.
- `redeem(claim_code)` for representatives only. Marks as collected with timestamp and representative id. Rejects already collected codes.

Every state change is written to an append-only event log table (session started, spin, reserve, answer, release, commit, redeem) for audit and the permit reports.

## 8. Question bank

### 8.1 Schema
| Field | Notes |
|---|---|
| id | Stable id |
| wall | Which booth wall holds the answer (for example map, timeline). Used for balancing |
| question | English only |
| options (4) | Each with an id and text |
| correct_option_id | Never exposed to the client |
| hint | Indirect hint |
| active | Allows disabling a bad question without a deploy |

### 8.2 Selection rules
- Random order, no repeats within a session.
- Prefer variety: avoid two consecutive questions from the same wall where possible.
- Shuffle option order per session, but check answers by option id.
- With 15 test questions, a session can use up to 8 (4 slots plus up to 4 replacements). The bank is sufficient for testing but visitors in a group will see overlapping questions. That is acceptable for the demo.

### 8.3 Import
Hatem fills the Excel template `adipec-2026-question-bank-template.xlsx` (tabs: Instructions, Questions, Walls). Columns in the Questions tab: question_id, wall, question, option_a, option_b, option_c, option_d, correct_option (A to D), hint, active (Yes or No), notes, check. Build the import against these exact headers. Import only rows where active is Yes and check is OK, and reject the whole file with a clear error report if any active row is invalid. Do not write questions yourself except as clearly labeled placeholders.

## 9. Identity, sessions and abuse

### 9.1 Duplicate detection
- Normalize email: trim, lowercase.
- Normalize phone: E.164.
- A match on either field counts as the same person.

### 9.2 Sessions
- Generate a random device token on first visit, stored in the browser, and a server-side session record.
- One active session per device token. Refreshing or reopening the link resumes the session.
- Sessions expire with their reservation.

### 9.3 Known abuse gap (document, do not over-engineer)
A visitor can open a new private window, get a new session and spin again before submitting, effectively rerolling for a better gift. Each reroll costs them the full question round, and duplicates are blocked at submission, so the damage is limited. Mitigations to include:
- One active session per device token.
- Rate limit session creation per IP (be careful: many visitors share the venue network, so keep the limit generous, for example 30 per minute per IP).
- Representatives verify the claim code on their dashboard before handing over.
Do not add CAPTCHAs or heavy fingerprinting. Explain the residual risk in the handover.

## 10. Representative dashboard

- Route: `/challenge/admin`, protected by Supabase Auth. Accounts are created by Hatem for named representatives. No public sign-up.
- Must work well on a tablet.
- Functions:
  - Look up a claim code: shows gift, name, time, status. Button "Mark as collected".
  - Live stock per gift: total, today's cumulative allocation, committed, reserved, collected, available.
  - Counters: sessions started, spins, completions, game overs, coffees, already won.
  - **Pause switch:** stops new sessions immediately (for emergencies or end of day). Active sessions can finish.
  - Exports (CSV):
    1. Leads (all completed forms, gift and coffee), tagged with source `adipec2026_spin` and visitor type, ready for Excel cleaning and upload to MS 365 Sales CRM.
    2. Winners list with residence (for the permit).
    3. Unclaimed prizes (committed but not collected) for the Red Crescent report.
- No editing of weights, allocations or gift list from the dashboard.

## 11. Data model (minimum)

- `spin_config` (event dates, timezone, timer seconds, hold minutes, paused flag)
- `spin_gifts` (id, name, value_aed, total_stock, chance_weight, daily_allocation, sort_order)
- `spin_sessions` (id, device_token, state, spin_count, reserved_gift_id, reservation_expires_at, question_slot, created_at, src)
- `spin_session_questions` (session_id, question_id, slot, attempt, deadline, result)
- `spin_questions` (see 8.1)
- `spin_entries` (session_id, type gift or coffee, contact fields, normalized email, normalized phone, consent flags, claim_code, gift_id, committed_at, collected_at, collected_by)
- `spin_events` (append-only audit log)
- Unique constraints: claim_code; one gift entry per normalized email; one gift entry per normalized phone (adjust for 5.3).

Keep these tables separate from the existing landing page tables. Do not modify existing tables.

## 12. Security

- Row Level Security on every new table. The anonymous role has no direct table access. All visitor actions go through the server functions.
- Server functions run with elevated rights and validate every input.
- Correct answers, weights and stock math are never exposed to the client.
- Admin functions check that the caller is an authenticated representative.
- The service role key is never shipped to the browser.
- Store only the personal data listed in 6.6.

## 13. Hosting, environments and capacity

### 13.1 Environments and access
- Gulf Cryo has a **Supabase** account.
- **Demo database:** a separate Postgres schema (for example `spin_demo`) inside the project, exposed to the API, with the same functions. A second Supabase project is the alternative only if Hatem approves the extra cost. Demo data is never copied to production.
- **Demo link:** the Netlify deploy preview or branch deploy of `feature/challenge`, pointing to the demo schema through environment variables. Confirm the URL serves `/challenge` correctly.
- **Production:** after approval, merge to the production branch so the game is served at the link, pointing to the production schema.

### 13.2 Demo-only tools (must be disabled in production by environment flag)
- Reset my session.
- Simulate a different event day.
- Shorter timer option.
- Seed small stock to test out-of-stock and race conditions.

### 13.3 Capacity
- Plan for several hundred visitors per day and bursts of 50 or more simultaneous players (for example after a booth presentation).
- Check the Supabase plan. The free tier pauses inactive projects and has tight limits. A paid plan must be active for the show week. Flag this to Hatem with the cost.
- Keep the visitor bundle small (target under 300 KB gzipped, excluding fonts). No heavy animation libraries; the wheel can be SVG or canvas with CSS transforms.

## 14. Reliability at ADIPEC

The venue network will be congested and nobody can patch bugs live. Design for failure:

- **Retries:** every server call retries with backoff and an idempotency key, so a retry never double spins, double answers or double submits.
- **Resume:** any refresh, crash or phone lock returns the visitor to the exact same step.
- **Timer fairness:** the server deadline includes latency grace. If a call fails because of the network, show "Reconnecting" and do not count it as a timeout until the server says so.
- **Clear error states:** never show a blank screen or a raw error. Offer "Try again" and, if it keeps failing, "Please ask a Gulf Cryo representative".
- **Fallback plan (document for the team):** if the system is down, representatives use a printed backup: paper form for leads and a printed question sheet. Provide this as a one-page PDF in the handover.
- **Monitoring:** dashboard shows the last successful server call time. Errors are logged with session id.
- **Code freeze:** no deployments from 1 to 5 November. Production build is frozen and tested before 1 November.

## 15. UI, brand and copy

- Colors: Navy #365888 (primary), Black #000000, Grey #909496, Dark Grey #5B5E61, Light Grey #E7EBEF, White #FFFFFF. Green and red only for answer feedback, both with icons or text, not color alone.
- Fonts: Museo Sans (brand) if a licensed web font is available, otherwise a clean system fallback such as Segoe UI. Ask Hatem before loading any font.
- Tone: confident, short, mature. Industrial, not playful. No "amazing", "excited", "lucky you", exclamation-heavy copy, emojis or confetti explosions. A restrained celebration is enough.
- Forbidden words (permit): "exclusive", "new", "for the first time", any guarantee claims.
- No em dashes in any copy.
- Large tap targets, readable in bright exhibition light, works on iOS Safari and Android Chrome, no app install.
- Accessibility: sufficient contrast, focus states, screen reader labels on the wheel result.

## 16. Testing and acceptance criteria

The demo is accepted when all of the following pass on the public link:

1. Full winner path on iOS Safari and Android Chrome.
2. Try again on first spin, guaranteed gift on second spin.
3. Statistical test: 10,000 simulated spins at full stock match the expected probabilities in 4.4 within 1 percentage point.
4. Out-of-stock gift is never selected; all gifts out of stock blocks spinning.
5. **Concurrency test:** with 1 unit left of one gift and 200 simultaneous spins, exactly one session receives it. No negative stock, ever.
6. Reservation expires after the hold time and stock returns.
7. Wrong then correct, wrong then wrong (game over), timeout (game over) all behave as specified.
8. No question repeats in a session.
9. Refresh at every step resumes correctly.
10. Duplicate email and duplicate phone both trigger "already won" and release the reservation.
11. Double tap on spin, answer and submit never creates duplicates.
12. Claim code redeems once; second redemption is rejected.
13. Day rollover at midnight Gulf Standard Time increases allocation and carries over unused stock.
14. All exports produce correct CSVs.
15. Timer: answering at 44 seconds succeeds; no answer at 45 seconds (plus grace) ends the game; a network drop does not count as a timeout until the server confirms it.
16. Anonymous users cannot read or write any table directly (verify with the anon key).
17. Load test: 300 concurrent simulated sessions complete without errors (for example with k6).

## 17. Delivery plan

1. **Read and question:** review this brief and the repo, check Supabase and Netlify access (0.1). Send back a short list of questions, risks and proposed changes before building.
2. **Skeleton:** screen flow with placeholder content on the demo link, for Hatem to validate.
3. **Demo:** full logic, the test questions from Hatem's Excel file, demo tools, acceptance tests.
4. **Hardening:** fixes from testing, full question bank, production config, load test, fallback PDF.
5. **Production release:** deployed and frozen before 1 November 2026. Show runs 2 to 5 November.

Today is 23 October 2026. The schedule is tight. Prioritize correctness of the prize engine and resilience over visual polish.

## 18. Handover must include

- Branch, migrations and a README covering setup, environment variables, deployment and rollback.
- Demo link and admin link, with test accounts.
- How to import questions.
- How to pause the game, and the booth checklist (pause when the QR stand is removed, resume when it is placed).
- List of open decisions from section 5 with the defaults used.
- Known risks and residual abuse gaps.
- Test results for section 16.
- One-page fallback PDF for the booth team.

## 19. Do not

- Do not move the domain or ask for DNS changes.
- Do not decide outcomes, stock or answers in the browser.
- Do not add cash prizes, purchase requirements or anything that makes entry paid.
- Do not write questions or change prize details on your own.
- Do not deploy during the show (1 to 5 November).
- Do not mark anything as tested if it was not.
