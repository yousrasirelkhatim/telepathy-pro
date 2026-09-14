# Switching the Paymob Account

This project uses a single set of Paymob credentials that live in **Firebase
Functions Secret Manager** (for the two secrets) and **RTDB `settings/`** (for
the two public values). Switching to a different Paymob account is therefore
a **configuration change only** — no code edits, no redeploy of the front-end.

The helper script `scripts/switch-paymob-account.sh` performs the whole switch
in one command, reading the new credentials from a **local, untracked** file
so the keys never end up in shell history or a chat transcript.

## 1. Prerequisites (one-time)

On your local machine:

```bash
npm install -g firebase-tools
firebase login
firebase use four-fruits-fun
```

You must have **admin** access to the `four-fruits-fun` Firebase project.

## 2. Collect credentials from the NEW Paymob account

Log in to [eg.dashboard.paymob.com](https://eg.dashboard.paymob.com) with the
account you want to switch to, and copy the 4 values:

| From dashboard | Field in the script |
|---|---|
| Settings → API Keys → **المفتاح السري** (Secret Key) | `PAYMOB_SECRET_KEY` |
| Settings → API Keys → **مفتاح HMAC** | `PAYMOB_HMAC_SECRET` |
| Settings → API Keys → **المفتاح العام** (Public Key) | `PAYMOB_PUBLIC_KEY` |
| Integrations page → numeric IDs for enabled methods | `PAYMOB_INTEGRATION_IDS` |

Make sure the new account has an **Online Card / Unified Checkout** integration
enabled — the code uses Paymob's Intention API (`/v1/intention/`), not the
legacy Auth flow.

## 3. Run the switch

```bash
cp scripts/.env.paymob.example scripts/.env.paymob.new
$EDITOR scripts/.env.paymob.new        # paste the 4 values, save
bash scripts/switch-paymob-account.sh
```

The script will:

1. Verify the Firebase CLI is authenticated and can reach `four-fruits-fun`.
2. Verify `.env.paymob.new` is not tracked by git.
3. Push all 4 values into Firebase Functions Secret Manager.
4. Update `settings/paymobPublicKey`, `settings/paymobIntegrationIds`, and
   set `settings/paymobEnabled = true` in RTDB.
5. Redeploy Cloud Functions so the new secrets take effect.
6. Print the webhook URL you need to register in the new Paymob dashboard.
7. **Shred** the local `.env.paymob.new` file so the keys don't linger on disk.

The script asks for an explicit `YES` before it applies anything.

## 4. Register the webhook in the new Paymob account

The script prints the URL after a successful run. Register it in the new
Paymob dashboard as **both**:

- Transaction Response Callback (POST)
- Transaction Processed Callback (POST)

```
https://us-central1-four-fruits-fun.cloudfunctions.net/paymobWebhook
```

## 5. Verify

1. Open [teleplay.online/admin](https://teleplay.online/admin) and check the
   Paymob checklist — every field should be `true` and `ready: true`.
2. Place a small real order and confirm:
   - `createPaymobCheckout` returns a checkout URL.
   - After payment, the webhook fires and the `JS-*` session cards appear
     under `/my`.

## Notes & gotchas

- **Do not switch keys partially.** If `PAYMOB_HMAC_SECRET` doesn't match the
  new dashboard, every incoming webhook will be rejected with 401.
- **Pending orders from the old account** won't receive their webhook. Watch
  `orders/` in RTDB for stuck `status: pending` entries and either wait for
  the old webhook to arrive (leave the old account webhook enabled for a few
  days) or fulfill manually via `claimOrderFulfillment`.
- **Currency must match.** The code assumes EGP piasters
  (`functions/paymob.js` → `toPiasters`). If the new account is on a different
  currency, that's a code change, not just a config change.
- **`scripts/.env.paymob.new` is git-ignored.** Never remove that rule from
  `.gitignore`.
