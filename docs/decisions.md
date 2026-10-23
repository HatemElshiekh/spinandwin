# Decisions log

Decisions made with Hatem on 23 October 2026, on top of `challenge-brief.md`. Where this file and the brief disagree, this file wins.

| Topic | Decision | Where it lives |
|---|---|---|
| Test question bank | 21 questions (Q01 to Q21) from the Excel file, all imported | `spin.questions` |
| Wrong answers | One wrong answer allowed per question, two in total per visitor. A wrong answer on a replacement question, or a third wrong answer anywhere, ends the game | `spin.config.max_wrong = 2`, `spin_answer` |
| Timeout | 45 seconds per question plus 2 seconds network grace. Timeout ends the game, no replacement | `timer_seconds`, `grace_seconds` |
| Coffee | Replaced everywhere by "Participation Gift" | UI, exports |
| Visitor type | Removed from the form and the exports | form, `spin_admin_export` |
| Reservation hold | 10 minutes from the spin | `hold_minutes = 10` |
| Reserved but not claimed stock | No separate message. Visitors see the normal flow | `spin_spin` |
| Probabilities | Fixed. They do not change with remaining stock. Seleo stays the rarest gift | `spin.draw` |
| Wheel | As in the brief: spin 1 is 50% "Try again", spin 2 always lands on a gift. 10 slices | `try_again_share = 0.5` |
| Drawn gift out of stock | The visitor goes to the participation gift (no redraw) | `end_reason = 'no_stock'` |
| Extra stock during the show | Managers add stock from the dashboard. It counts from that day. It cannot be removed there | `spin_admin_add_stock`, `spin.stock_adjustments` |
| Fonts | Museo Sans is licensed. Waiting for the woff2 files; system fonts until then | `src/shared/base.css` |
| Netlify | New site linked to this repo; branch deploy protection removed so the demo link is public | Netlify settings |

## Defaults used that still need confirmation

1. **Pause and first spins.** When paused, new visitors see "closed", and visitors who opened the page but have not spun yet cannot spin. Visitors already past the spin can finish.
2. **Hold expired before the form was sent.** If a unit of that gift is still free, the visitor keeps the gift. If not, they get the participation gift.
3. **Duplicate message.** "You have already taken part. This email or mobile number has already been used in the challenge. The challenge is available once per person." (the brief's "you already won a gift" is wrong for participation gift recipients).
4. **Consent wording** and the optional marketing checkbox on the form. Both need legal review.
5. **Terms text** is a draft written from the brief rules and is marked "Draft" on screen.
6. **Roles.** Representatives can look up and redeem codes, see stock and use the pause switch. Managers can also add stock and download exports.
7. **Rate limit.** 60 new sessions per minute per IP address (the brief suggested 30; the venue Wi-Fi may put many phones behind one address).
8. **Residence list.** The 7 Emirates and the GCC countries, plus "Other country" with a text field.
9. **Phone country codes.** A short list of common codes plus "Other" for a full international number.
