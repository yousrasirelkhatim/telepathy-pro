# Teleplay — تحدي التخاطر (Telepathy Challenge)

Two-player real-time mind-sync game. Players answer 4 phases × 5 rounds of
questions simultaneously; the match percentage is their "telepathy score".
Monetized through session codes sold via Paymob (Egypt) / Stripe / WhatsApp.

**Production:** [teleplay.online](https://www.teleplay.online) ·
**Firebase project:** `four-fruits-fun` ·
**Operator:** [ineed4ecommerce.online](https://ineed4ecommerce.online/)

---

## ⛔ Red lines — DO NOT TOUCH

These files implement the Core Challenge Logic and the session entry flow.
They are the product. Any change to them requires explicit owner approval:

| File | Why it's frozen |
|---|---|
| `public/play.html` | Game loop: rooms, phases (1–4), rounds (0–4), 15s timer, exact-match scoring at 25% per phase, results, realtime RTDB state machine |
| `public/js/session-entry.js` | TPSession — buyer/friend/manual entry flows. **Invite links use `?room=ROOMID` only — never `?session=` or `?code=`** (that caused duplicate rooms historically) |

Also load-bearing (change with extreme care):

- `functions/provision.js` — session card provisioning (mirrors `public/js/account.js provisionFromOrder`; keep both in sync)
- `database.rules.json` → `rooms/`, `accessRooms/`, `sessionIndex/`, `accessCodes/` branches
- `EXACT_SCORING_LOCKED = true` in `public/app-2026.js` — keeps AI similarity scoring disabled; exact-match is the launch rule

---

## Architecture

```
public/                          ← Firebase Hosting (no build step)
  index.html      Landing + packages + buy modal (+ optional promo codes)
  play.html       ⛔ THE GAME (frozen)
  my.html         Customer account: session cards, orders
  admin.html      Admin + reseller panel (tabs: overview/orders/codes/accounts/
                  resellers/pricing/settings/marketing/wallet)
  card.html       Shareable result card generator
  payment-success.html / payment-cancel.html
  app-2026.js     Progressive enhancement layer over play.html (PWA/audio/voice)
  sw.js           Service worker: network-first HTML, cache-first assets
  js/
    codes.js         TPCodes — RTDB hub: access codes, orders, packages,
                     pricing, settings, FAQ, promo codes, affiliates
    session-entry.js ⛔ TPSession (frozen)
    account.js       TPAccount — customer profiles + session cards
    phone-auth.js    TPPhoneAuth — Firebase phone OTP + reCAPTCHA
    payments.js      TPPayments — Paymob/Stripe checkout wrappers
    share-card.js    TPCard — canvas result card renderer

functions/                       ← Cloud Functions v2, Node 20, us-central1
  index.js        Callables: applyPromoCode, createPaymobCheckout,
                  createStripeCheckout, claimOrderFulfillment,
                  ensureAdminAccess, getPaymobSetupStatus
                  Webhooks: paymobWebhook, stripeWebhook (both deduped)
  paymob.js       Paymob Intention API + HMAC-SHA512 verification
  promo.js        Promo/discount evaluator (single authoritative pricing impl)
  provision.js    Creates JS-XXXXXX session cards after successful payment

database.rules.json              ← RTDB security rules (schema-validated)
```

### Payment flow

```
Buy modal → phone OTP → createOrder (RTDB, status=pending)
  → createPaymobCheckout / createStripeCheckout   ← promo validated+applied HERE (server-side)
  → gateway redirect → customer pays
  → webhook (HMAC/signature verified, transactional dedupe)
  → fulfillPaidOrder → provisionFromOrder → session cards in userData/{phoneKey}
  → settleAffiliateForOrder (idempotent via orderPromoIndex) → affiliate commission
payment-success.html additionally calls claimOrderFulfillment as a webhook backup.
```

### Key RTDB nodes

| Node | Access | Purpose |
|---|---|---|
| `rooms/{ROOMID}` | ⛔ game | Live game state |
| `accessCodes/{code}` | public read (single) | Code validation before play |
| `sessionIndex/{JS-*}` | public read | Session card → owner lookup |
| `orders/{ORD-*}` | owner/admin | Purchase lifecycle |
| `userData/{phoneKey}` | owner/admin | Profile + session cards |
| `packages`, `pricing`, `settings`, `faq` | public read, admin write | Product config |
| `promoCodes/{CODE}` | **admin only** | Discount + commission config (validated via `applyPromoCode` callable) |
| `affiliates/{id}` | admin only | Marketer totals + payouts |
| `promoUses/`, `affiliatePayouts/` | admin read | Append-only audit logs |
| `paymobProcessed/`, `stripeProcessed/`, `orderPromoIndex/` | server only | Webhook idempotency guards |

---

## Deploy

CI (GitHub Actions):

- **Hosting** — auto on merge to `main` (`firebase-hosting-merge.yml`)
- **Functions + DB rules** — auto on merge when `functions/**` or
  `database.rules.json` change (`firebase-backend-deploy.yml`).
  ⚠️ Requires the service-account secret to have the IAM roles listed at the
  top of that workflow file. Until granted, deploy backend manually:

```bash
firebase deploy --only database,functions --project four-fruits-fun
```

Manual full deploy:

```bash
firebase login
firebase deploy --project four-fruits-fun     # hosting + database + functions
```

### Server secrets (Functions → Secret Manager)

See `functions/.env.example`. Set with `firebase functions:secrets:set NAME`:
`PAYMOB_SECRET_KEY`, `PAYMOB_HMAC_SECRET`, `PAYMOB_PUBLIC_KEY`,
`PAYMOB_INTEGRATION_IDS`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`ADMIN_PHONES`, `APP_ORIGIN`.

To rotate the Paymob account safely use `scripts/switch-paymob-account.sh`
(reads keys from a local git-ignored file, never from chat/shell history).

### Rollbacks

- Git snapshots: branches `production-baseline-*`, `backup-*`, tags `v-production-*`
- Hosting: Firebase Console → Hosting → release history → rollback
- Functions: redeploy from the snapshot branch

---

## Conventions

- **No build step.** Vanilla HTML/CSS/JS + Firebase compat SDK via CDN.
  Keep it that way unless the owner decides otherwise.
- **Cache busting:** all `public/js/*.js` references share one `?v=N` version.
  Bump N on every JS change (see `grep -rn 'js?v=' public/`). `play.html`
  pins its own version and is only bumped with owner approval.
- **Pricing is server-authoritative.** The client never computes money.
  All discount math lives in `functions/promo.js`.
- **Webhooks must stay idempotent.** Every settlement path is guarded by a
  transactional claim (`cur === null ? claim : undefined` — abort on repeat).
- **Arabic-first UI**, with `lang=en` i18n overlay on landing + play.
