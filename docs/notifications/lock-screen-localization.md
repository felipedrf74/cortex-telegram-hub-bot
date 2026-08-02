# Lock-screen copy localization

**Status:** decided and implemented (backend). The `loc-key` successor is
designed but deliberately unshipped — see *Why not loc-key yet*.

## The problem

`users.language` defaults to `pt-BR` (`src/services/user-service.ts`, schema
default). Producers already ship PT/ES copy in-app. But every string that
reaches a **locked phone** was hardcoded English:

- `safeNotificationTitle` — 8 per-skill titles plus a schedule variant
- `buildPrivacySafeBody` — 5 privacy-class bodies plus a composite
- `assembleDailyDigest` — title, empty state, and slot labels

So the product was trilingual in-app and monolingual on the one surface a user
sees without unlocking their phone, for a user base whose default is Brazilian
Portuguese.

## The decision

**Resolve lock-screen copy server-side from a stable key, using the account
language. Choose the keys so they are exactly the `loc-key` names a future
payload will carry.**

Copy lives in `src/utils/i18n.ts` under the `notif.*` namespace, resolved by the
existing `t(key, lang, vars)` helper. The orchestrator resolves the language
once per evaluation via `notificationCopyLanguage(userId)`.

Producers are unaffected: they never wrote lock-screen copy in the first place
— `buildPrivacySafeBody` exists precisely to guarantee that — so this changes
nothing about how a notification is created.

## Why not `loc-key` yet

`aps.alert.title-loc-key` / `loc-key` is the better end state, for two reasons
this implementation does **not** achieve:

1. It follows the **device** language, not the account language. A user whose
   phone is in English but whose account is pt-BR gets the wrong one today.
2. No prose crosses the wire at all — the server sends a key plus non-sensitive
   args, which is a strictly better privacy posture than sending a fixed
   sentence.

It is not shipped because it cannot be shipped safely from the backend alone:

- **If a key is missing from the app bundle, iOS renders the raw key.** A user
  would see `notif.body.finance` on their lock screen.
- **The backend deploys independently of the App Store.** A backend release can
  reach a device running an app build from months earlier.
- The iOS side (Localizable.strings + a build that ships them) is a separate
  repo, and verifying the rendered result needs device proof that is currently
  an open release gate (`PROD-APNS`, `DEVICE-PROOF`).

## How to ship `loc-key` later

The pieces are already in place:

1. `notification_device_tokens.app_version` is populated on registration, so the
   server can tell which devices support loc-keys. `getPushTokensForUser` does
   not currently select it — that is the one schema-side change needed.
2. `NOTIFICATION_TITLE_KEYS` and `notificationTitleKey()` are exported from
   `notification-orchestrator.ts` and are the canonical key names. The iOS
   `Localizable.strings` file must use these verbatim.
3. Send loc-keys **only** to device tokens at or above the first app version
   that bundles the strings; keep sending resolved text to everything older.
   This is a payload-layer branch in `apns-sender.ts`, not a producer change.

Do not skip step 3. A blanket switch is what turns this into an incident.

## Consequences

- The account language is now load-bearing for notifications. A user who never
  chose a language gets pt-BR, which is the product default everywhere else.
- Copy edits are translation edits: changing an English string without its
  siblings leaves other languages stale. `notification-localization.test.ts`
  sweeps the `notif.*` namespace **derived from the message table itself**, so
  keys built by string template — the 22 `notif.digest.slot.*` entries — are
  covered without anyone remembering to list them.
  - The sweep asserts presence with `hasTranslation`, **not** through `t()`.
    `t()` falls back pt-PT → pt-BR → en-US → key, so the earlier
    `expect(t(key, lang)).not.toBe(key)` assertion could not fail for any key
    that existed in English: it was a guard in name only.
  - pt-BR, en-US and es-ES are required outright. pt-PT is required only to
    *resolve*, because it deliberately inherits pt-BR and carries its own entry
    only where European Portuguese differs (`ligação` vs `conexão`).
- Digest slot labels carry **separate singular and plural entries**. English can
  build "3 decisions waiting" by concatenating a number and a noun; Portuguese
  and Spanish inflect it ("1 decisão pendente" / "3 decisões pendentes"), so the
  concatenation approach does not survive translation.
- Suites that assert redaction and routing (`notification-orchestrator`,
  `notification-orchestrator-security`, `notification-correctness-phase0`) pin
  `getUserLanguageById` to `en-US`, so they keep testing what they tested
  before. Language behaviour is owned solely by
  `notification-localization.test.ts`.
- One extra indexed `users` lookup per evaluated notification, and failure falls
  back to the default rather than throwing — copy resolution must never fail a
  delivery.
  - "Once per evaluation" was aspirational when first written and false in
    practice: `safeNotificationTitle` and `buildPrivacySafeBody` each resolved
    the language independently, so it was **two** lookups per notification — and
    two even for `daily_digest`, the branch that discards the value. Both now
    take the resolved language as an argument, at all three delivery call sites.
