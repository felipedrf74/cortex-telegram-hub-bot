# Changelog

All notable changes to Nexus Hub (formerly Cortex Telegram Hub Bot) are documented in this file.

---
## [Unreleased]

### Bug Fixes

- **training**: Harden plan intelligence and apple health status ([`ca20398`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ca203981a916e19c4287d5eb573833f6a0223206))
- **training**: Repair stale calendar sync links ([`9c4a4a0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9c4a4a09881cf2887b7980080769a0fb49c86bcc))
- Harden secretary calendar and task state ([`1885607`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1885607465c4327f4dbef75c854e4ba8efac3eaa))
- **secretary**: Harden calendar and task sync ([`74170fb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/74170fb52567ca19a8182337d072bc26339c713b))
- **training**: Refresh stale adherence signals ([`b4e6d08`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b4e6d0817483a4155d9928e4ad3a1e82aa784101))
- **training**: Throttle calendar event sync ([`c1ce81d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c1ce81dfb1a139f441f12c6fba1fd9a353689a35))
- **training**: Keep strength plans gym-focused ([`08dd579`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/08dd57955a7fc129a11e2e12c800ede2e580c33f))
- **training**: Align week calendar sync truth ([`be558c5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/be558c5c1d3fc8fa5474345353a489871ed32304))
- **training**: Harden plan calendar sync ([`7fd2463`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7fd2463b7a8e2db17b1ba5fae560b09d7adc6c05))
- **training**: Clear probe-history on reauth + isolate calendar failures from week sessions ([`6df4f00`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6df4f00ae87547ee1c7877b6845298b426445874))
- **training**: Wipe per-user coach state when a plan is cancelled ([`cc4aecb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cc4aecba03472f34e415775e541e612e11d09381))
- **calendar**: Per-user Outlook configured check (not owner-global) ([`b0ad0dd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b0ad0ddd11c85a90331c75d3318ea4f9f081728c))
- **training**: Harden coach engine ([`45f3a1c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/45f3a1cf74f795001e1ce0bbc16ef298b654f5e4))
- **content**: Remove single-tenant script prompt ([`1300b20`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1300b20f8fc2d8084d03773b63b387980ef7726f))
- **content**: Refresh script quality cache key ([`b3af515`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b3af515d69bcf3febdddcb452cbef5b91a7ce289))
- **content**: Strip markdown emphasis from scripts ([`03cd76e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/03cd76e1780fa47d7cb621188048ccd96266c55d))
- **deploy**: Avoid overstrict prod port env gate ([`0e9b6e3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0e9b6e30cca04cf49c8d755a195f12215c5c5c8f))
- **content**: Clean script section dividers ([`88835f7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/88835f728be760c0517a1e78c5ab3671270164c1))
- **content**: Restore AI script synthesis quality ([`fc338d5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/fc338d5906df86469eb003b62644b34b8c696bbf))
- **training**: Harden coach fallback and profile gates ([`c4f2dde`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c4f2dde97cdc4e5853598320760ae43f99e952ab))
- **beta**: Ship TestFlight backend fixes ([`f16c8d8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f16c8d89c66e9df5a487d8977050f1e41cd5dad9))
- Exclude worktree git file during deploy ([`5cd7cad`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5cd7cad8ebac3718af54e75ad5549928c256e492))
- **tasks**: Coalesce route lookups ([`a1e38b6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a1e38b63f4c1449a3ea9882653b80491d20b1d5e))
- Localize app-facing portuguese backend surfaces ([`c1671bb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c1671bb2e3d0e2829e3e7c90f56e884efba0ea62))
- **auth**: Emit canonical error envelope on 401s ([`ed73c68`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ed73c680e9e191deeccb13434d57216d59b6618e))
- **push**: Drop duplicate terse briefing pushes so the tap deep-links ([`be99b14`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/be99b14afbdd246ec14275289cad9649ee6be1d2))
- **smoke**: Accept both envelope shapes iOS client decodes ([`00af495`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/00af4953615f5c6fda6869a9da20c0e4bac72469))
- Bump non-secretary maxTokens 1024→2048 + copyright header ([`89151ea`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/89151eac1c6e309e710aa92af949da9c1b6c9663))
- CHAT-M1/M2/M3/M4 — complete remaining manual test plan failures ([`9c6377b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9c6377b145e380c6a61f5bf5de9422e0160ce875))
- TASK-M8 checklist expand, TASK-M7 move copies checklists, CONT-M1/M4 null safety + brand voice ([`e92e56f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e92e56fed425cebab050094e429ffb6e153805e8))
- Harden receipt parsing and training plans ([`544412a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/544412a5d88e979d5e767965dec7f21fa79ad671))
- Unskip all 9 adherence-signal tests — 4015/4015 now pass ([`4fbc8cc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4fbc8cc0d4c4e6e26a09fe5381f5aed53855feb7))
- Training keywords PT + receipt currency/confidence improvements ([`f5d8a9a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f5d8a9ae86259060f0dd1913103b6792e3df5f38))
- Inbox 404 + last_active_at tracking + content data migration ([`ae63cd8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ae63cd87594dddfacce7ea0d7cce8041e0270766))
- Training plan JSON parsing — better extraction from AI response ([`557594f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/557594f2396d27ba43b3bf0c526b7920a4f7f6bc))
- Outlook ConfidentialClient + Garmin data isolation per user ([`da37e0a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/da37e0a969741fd970707efacffdd7ffef395781))
- Google Sign-In links to existing user by email instead of duplicate ([`7def411`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7def411123ea8f33914aeacb4b9f2d1418064306))
- Google PKCE — don't send client_secret for iOS native clients ([`ccff5db`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ccff5dbd17679422caa19d03c0c44b7f77857182))
- Add 'founders' to SECTIONS array — nav button was falling back to dashboard ([`776295c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/776295cce8a91fe08bf5a6dadf24a89ab62541de))
- Paywall gates for multi-auth users + auto-seed pro subscription ([`7dca6ae`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7dca6ae8ec6ccdba707ca3f8fd74af7d6207a32a))
- Security + coach metrics + training parity for public release ([`7657a61`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7657a61d3fc8acfe8b46897b949c406a97bbc8c7))
- Launch blockers — Apple Health training route + Telegram isolation ([`b74adef`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b74adef0a225312e3e7b804036bb73d8632d13ba))
- Weekly review structured data, script caching, dashboard provider gate ([`30e029c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/30e029cff15c74817878a60ee2d2ecfa454b01ec))
- Canonical script pipeline — fix fake-userId bug, unify generation paths ([`f63726b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f63726b12a98408eb361b24fb7a2a8d385fbe33f))
- V4.14.2 — complete portal identity migration + regression tests ([`f405675`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f40567531149a30bd740b5f03696d27550729888))
- V4.14.0 — portal security hardening ([`db07d3a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/db07d3a042cdc392b2d844eb3102855499a270f0))
- V4.13.0 — strict multi-tenant isolation ([`6cccb0c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6cccb0c7d7eae17e3a8e4d5170bddfe231320fbc))
- V4.12.2 — remaining security items ([`aff68c2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/aff68c2ca520bbeb9a0f2a86a265f085b53b62ba))
- V4.12.0 — multi-tenant hardening from security audit ([`f55a970`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f55a970f618c92cbf84ad9c80af183a290b11146))
- V4.11.2 — final multi-user isolation fixes ([`48bef86`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/48bef866597cf7739943f32f65d8dfdd9a1f968b))
- V4.11.0 — complete multi-user query isolation ([`5857d47`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5857d47be557305f035c74c705dd6139e7f2f8bb))
- Secretary default list + plan generation response + signals hide when empty ([`bfce7f7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bfce7f7dd91442d44c23363b2e29a6ec3b54986c))
- Per-user task routing in AI tool executor ([`471a82c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/471a82c3957f6f6bec89b10777861a3215f8c4b2))
- Owner detection for iOS users + per-user calendar source ([`de81d50`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/de81d50e07c274666137d47a4361fd176f04aee6))
- **onboarding**: Map correct field names in questionnaire response ([`3661d3a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3661d3af067b8401a2238266e71bb01971d2e8a2))
- **onboarding**: GetSession → getActiveSession — questionnaire taps ([`fa0e8cb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/fa0e8cbcfd39ea4056f6f10f8e93b334acebca88))
- **onboarding**: Fix questionnaire function name + resolve definitions ([`c531fdb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c531fdb69cb3d05c7011bb0e37ed4c5a1ce8c659))
- **auth**: GetUserById fallback for iOS users in skills + chat routes ([`b3f7821`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b3f7821b2169c12188c720887d5aa8a35b90b6ab))
- **isolation**: Garmin data scoped to owner only — non-owners get null ([`adcd30d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/adcd30d953896cc327401f5286a5951c2af01494))
- **isolation**: Per-user content pipeline + vendor scoping ([`a15cba4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a15cba40ffdf918ab50930f168935812ed21d43d))
- **isolation**: Invoice vendors scoped to owner only ([`f31db14`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f31db14fb803d22646e70c3ffb59ab8f565f1e10))
- **isolation**: Per-user cache keys for calendar routes ([`18f4b9e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/18f4b9e033617ab87c322ead907d558a8aa0b600))
- **garmin**: Startup keepalive — close 30-min restart gap ([`4bb4885`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4bb488500de22c06490be20abd328b2e394cf195))
- **isolation**: Per-user cache keys for task routes ([`67ce9d7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/67ce9d7d7b801fc2d206d10d5ba90665c71df347))
- **auth**: Separate owner code from beta code — protect personal data ([`749ea0b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/749ea0b23ee09444876e0f92c790e629f40d01f8))

### Chores

- Bump version to 4.14.93 [deploy] ([`6f996b9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6f996b9d0f1389bc7c2b1fef64e4d55df5fae952))
- Bump version to 4.14.92 [deploy] ([`0ec039a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0ec039a4533f2479013037b953721fff831e9e0f))
- Bump version to 4.14.91 [deploy] ([`dbb519e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dbb519e0a5fb4536a6982fbd7b658bfb749fe941))
- Bump version to 4.14.90 [deploy] ([`e401f2f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e401f2f546b2a69be96ee24c2e3417e68eed3ee5))
- Bump version to 4.14.89 [deploy] ([`5447fe8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5447fe81c9ae2248cf74fa5a179a57ce8a7711d5))
- Bump version to 4.14.88 [deploy] ([`927b16a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/927b16a9c90cda38453dbad1fae983d07ec99863))
- Bump version to 4.14.87 [deploy] ([`d383936`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d3839369788a1764d48ecbd4e51532eb12c117b2))
- Bump version to 4.14.86 [deploy] ([`954e742`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/954e742ee2fe08dd913d1973ae3effa159c30bab))
- Bump version to 4.14.85 [deploy] ([`afbbc84`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/afbbc841996bc9573f48f97f14ebdfa1b0ba08a2))
- Bump version to 4.14.83 [deploy] ([`9e135e3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9e135e36ae967da97c6a6e1ded1bff2eaf256927))
- Bump version to 4.14.82 [deploy] ([`fa22872`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/fa22872fd79adf41624e9ce78a2ce231293ea08f))
- Bump version to 4.14.81 [deploy] ([`656bb6f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/656bb6f54fd70c98a69ebe2fc1bbbbc6381348b3))
- Bump version to 4.14.80 [deploy] ([`a7b009e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a7b009e304a15de62b73e5ebd7e8ec6a0f416fae))
- Bump version to 4.14.79 [deploy] ([`391f281`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/391f2814f9ee2ba964e4f638f4b4ecee409e7496))
- Bump version to 4.14.78 [deploy] ([`d5530a7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d5530a7dd665a2011c782b3ef6fa88637c429b49))
- Bump version to 4.14.77 [deploy] ([`44766ed`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/44766ed8fea7ec80f20520198577bbb896b360d5))
- Bump version to 4.14.76 [deploy] ([`b8fd82c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b8fd82c2849d247da00657f49e5fed45f9a122d4))
- Bump version to 4.14.75 [deploy] ([`80b6715`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/80b6715d7d01c4da1dff5b6d286bff4af2a49566))
- Bump version to 4.14.74 [deploy] ([`0f7fd74`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0f7fd74363b2e54b9dd6e4f3f97ea8ea737dfa00))
- Bump version to 4.14.73 [deploy] ([`61f9d1c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/61f9d1c35ad650690f2076e2373e1b06977165f4))
- Bump version to 4.14.71 [deploy] ([`e8239e8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e8239e8865447c0501cd5fcf270b2fa514158c6c))
- Bump version to 4.14.70 [deploy] ([`4fbc32b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4fbc32b04800b66562a1a195fcc0d6d3bcba200c))
- Bump version to 4.14.69 [deploy] ([`cc8ac94`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cc8ac9414e4da530bf986918e035d7bb2d07cd55))
- Bump version to 4.14.68 [deploy] ([`a1a143a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a1a143acbc710a1ba812be01eec2bc216cd4e5a5))
- Bump version to 4.14.67 [deploy] ([`4e4cebb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4e4cebb016ddc61c98ba2de31bb290417d123203))
- Bump version to 4.14.66 [deploy] ([`c02ad3e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c02ad3e8f4c7724b18d82013afbd271d471ed138))
- Bump version to 4.14.65 [deploy] ([`b422ef6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b422ef6ccd36e0978cb84753125ba6bb0f3380dc))
- Bump version to 4.14.64 [deploy] ([`f9441a3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f9441a330521bdc6f5f4af98519e6ab3c7a3fcf6))
- Bump version to 4.14.63 [deploy] ([`163528e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/163528e5268c843a449bd97b352e5458ec0ee8b5))
- Harden backend release readiness ([`eb4a9c0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/eb4a9c059fabc3f2ed1eed288fd4f39a1ae1fd36))
- Bump version to 4.14.62 [deploy] ([`49b7ca7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/49b7ca7604acee74e0407490102e45383c559e69))
- Bump version to 4.14.60 [deploy] ([`4d1774b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4d1774bfb630b1f8f5917dc131446f0426ceb25e))
- Bump version to 4.14.59 [deploy] ([`6071f9c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6071f9c62abf493a11bd5dc454eaf87c22b4414e))
- Bump version to 4.14.58 [deploy] ([`3f26fc8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3f26fc899903d7e0d9053095fcd46df2370d4300))
- Bump version to 4.14.57 [deploy] ([`c3a6331`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c3a6331989a858e8768f92c7ad8886174c908181))
- Bump version to 4.14.56 [deploy] ([`4f73cb9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4f73cb9ed4f37753313b5c5450e515c79bd5162a))
- Bump version to 4.14.55 [deploy] ([`78241b8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/78241b80ff9e51924c29a758b6ab2f7d869c5d83))
- Bump version to 4.14.54 [deploy] ([`abd27ea`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/abd27eae090de62a1f326f260d7cc84ab33453d1))
- Bump version to 4.14.53 [deploy] ([`4e7090b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4e7090bf4d12ea681789524b4cc399c99348192c))
- Bump version to 4.14.52 [deploy] ([`b64f72c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b64f72c79d38b4cadcbebc2fb9ba168ec436ed9d))
- Bump version to 4.14.51 [deploy] ([`c2c6e09`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c2c6e097fc642a4e4c9066ea3c3172d3aad7f85c))
- Bump version to 4.14.50 [deploy] ([`ab20f07`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ab20f0741bfea42a257f4374c67c4b62d6cdf656))
- Bump version to 4.14.49 [deploy] ([`8fc39f2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8fc39f2bc425c3a3dce5f65f5b3b1a4db5883550))
- Bump version to 4.14.48 [deploy] ([`b09196d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b09196db46bc0187e083c98b1f4a93cf31e19cd7))
- Bump version to 4.14.47 [deploy] ([`0899b8f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0899b8f6535e301a7b90505072e3fecd56ca228f))
- Bump version to 4.14.46 [deploy] ([`0109782`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/010978215d1a76f1d1f5c4badeb509d15f195146))
- Bump version to 4.14.45 [deploy] ([`27f893c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/27f893cdebf0701505bccdc39f33094e985f2eb8))
- Bump version to 4.14.43 [deploy] ([`bd639f3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bd639f3287ade0e7bfc1812d9c287afec50c5dfc))
- Bump version to 4.14.42 [deploy] ([`352a20d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/352a20d16404c2211a8d40c5803cb8954c230d75))
- Bump version to 4.14.41 [deploy] ([`562403b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/562403b1c4bb79e34e6a3f872c1b7427b7f0ad5d))
- Bump version to 4.14.40 [deploy] ([`faac77b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/faac77ba8becb2456aaba22c9c8775ee15b75c2d))
- Bump version to 4.14.38 [deploy] ([`740a186`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/740a18667ffc3e3730eb07d57903ce4434f707a3))
- Bump version to 4.14.37 [deploy] ([`7256668`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7256668218e60c3ee2c6f0e31725907c5a3ba40e))
- Bump version to 4.14.36 [deploy] ([`e26ccdd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e26ccdde959958b5fa1e6e8fe4593f5ffba72b0e))
- Bump version to 4.14.35 [deploy] ([`223cf86`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/223cf862ed3806ee85dccc282c302fb368308d3c))
- Bump version to 4.14.34 [deploy] ([`6c1b8da`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6c1b8daebc4f97e5db43b66cf3029d0fdd6f037b))
- Bump version to 4.14.33 [deploy] ([`cfa4dd2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cfa4dd29d2c0c402afac27ef478dd0b5c0a240ae))
- Bump version to 4.14.32 [deploy] ([`16e4d14`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/16e4d14787958ece84cedc2fd4327c42de0af6e5))
- Bump version to 4.14.31 [deploy] ([`bfd3863`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bfd3863321d127619d7144d8ade2b300bdb5525b))
- Bump version to 4.14.30 [deploy] ([`bed4979`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bed4979870e62638a39f64461b298ea957f4d472))
- Bump version to 4.14.29 [deploy] ([`a6fa32d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a6fa32d91268bb1f2a8e67b637bff253d9784b13))
- Bump version to 4.14.28 [deploy] ([`f105a2a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f105a2a72d8223c1546db85ebd96ef4d13b995f9))
- Bump version to 4.14.27 [deploy] ([`eebe37c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/eebe37c63179d499870e14d69f1ac87fde88b72e))
- Bump version to 4.14.26 [deploy] ([`b8b8598`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b8b859885bbbcba1a3e2683429a9af60c56f43de))
- Bump version to 4.14.25 [deploy] ([`bca491e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bca491eb3d7cf807767f2e64e1110b54fcb93342))
- Bump version to 4.14.24 [deploy] ([`9a9a7bb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9a9a7bb774579327aba7bf3e8cc28f5f2c45137a))
- Bump version to 4.14.23 [deploy] ([`3bb1648`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3bb1648695398eb6662854e292cec7b28eddf574))
- Bump version to 4.14.22 [deploy] ([`b04d80e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b04d80eadee049cb2e12e6a402ed2f38eeff3665))
- Bump version to 4.14.21 [deploy] ([`1b144f1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1b144f1c093109d77d339ad7e409c71200edbc5f))
- Bump version to 4.14.20 [deploy] ([`26b8dc9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/26b8dc99839deed054aefe39bfa7b7db6ba3ec5a))
- Bump version to 4.14.19 [deploy] ([`541ca05`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/541ca05dd109067b87dac540257516073221317e))
- Bump version to 4.14.18 [deploy] ([`6e00a4f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6e00a4ff57c601098bbf65da6fdb74d7c4707144))
- Bump version to 4.14.17 [deploy] ([`1935821`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1935821d73122161b101b6fc65bae3aa2ae0547d))
- Bump version to 4.14.16 [deploy] ([`5db3ba2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5db3ba29836a737b089c632b33053ad1aa1db463))
- Bump version to 4.14.15 [deploy] ([`b70254b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b70254b6ffed1210f11fffb3bff8e327e7ee2a23))
- Bump version to 4.14.14 [deploy] ([`3cce2c3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3cce2c348ad6954c5afbe6df6d88d9cc09273e1a))
- Bump version to 4.14.13 [deploy] ([`ded18c9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ded18c942f1bc94abdc09eb556181af3a27ef96c))
- Bump version to 4.14.12 [deploy] ([`19f1cf5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/19f1cf561b7ab911a36c254bcd86d1322ed81a5b))
- Bump version to 4.14.11 [deploy] ([`b4f7eef`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b4f7eef0153ffcb9273f76bc7cf8fc98bb72d096))
- Bump version to 4.14.10 [deploy] ([`2d61d76`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2d61d76be7f8dd7f547d21ad88d29100d3c7f6e6))
- Bump version to 4.14.9 [deploy] ([`1da797b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1da797bb5e7b0d62b786f91efc5329f34e3c8c39))
- Bump version to 4.14.8 [deploy] ([`928b2f3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/928b2f3d82e6169a87264b0419758badadc16af6))
- Bump version to 4.14.7 [deploy] ([`2237cc6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2237cc6207352ae15c3c8e6b52e4f3ad168500e0))
- Bump version to 4.14.6 [deploy] ([`5d960d2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5d960d2b2d74b3f6879157e68f838adb782b2ce6))
- Bump version to 4.14.5 [deploy] ([`a7599c8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a7599c8573cae8eea24a951f672ee9231ab3ae95))
- Bump version to 4.14.4 [deploy] ([`55f8acc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/55f8acc2b63a3d525366c77db7007331134af4e2))
- Bump version to 4.14.3 [deploy] ([`f30fe6a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f30fe6a50b81ed3f52a7ed18d57673a70503af02))
- Bump version to 4.14.2 [deploy] ([`e5f55be`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e5f55be8d6069f74fef4d5f48dde7a9149cedef5))
- Bump version to 4.14.1 [deploy] ([`81731d0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/81731d0ed81bd8fe747c1874266b827662d33099))
- Bump version to 4.13.1 [deploy] ([`0ee273a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0ee273aa7161e255276e1523575546889859f0c6))
- Bump version to 4.12.3 [deploy] ([`207dcbd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/207dcbd27235f69bcd177f77eb13ea0a3665761d))
- Bump version to 4.12.1 [deploy] ([`dba609d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dba609dba6074434ee4ce55296310822cca026e5))
- Bump version to 4.11.3 [deploy] ([`02241a5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/02241a51cfa832126a3575bd26e70d3db6a88058))
- Bump version to 4.11.1 [deploy] ([`008ad29`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/008ad296d5c7ae53a1226ca7b907de6b23632356))
- Bump version to 4.10.9 [deploy] ([`169cf8e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/169cf8e7206e551a8f7386481e4de4b77fb52cc9))
- Bump version to 4.10.7 [deploy] ([`a2d65b5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a2d65b590a980c7d219d08c7d5baf09af82b8824))
- Bump version to 4.10.5 [deploy] ([`9669e0a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9669e0ac4cdda98d55c4982ee34a54d4e750587d))
- Bump version to 4.10.3 [deploy] ([`3feb378`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3feb378f61bbec5d37b64e59399049088d8e312c))
- Bump version to 4.10.1 [deploy] ([`16a3147`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/16a3147d370409e4c5d2547417051e66946f2587))
- Bump version to 4.9.100 [deploy] ([`29420e6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/29420e6e49c78a1c3bd779e6bd232422c75338fe))
- Bump version to 4.9.98 [deploy] ([`fd58ce4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/fd58ce414d26422e11db8d914f32c22c53232c24))
- Bump version to 4.9.96 [deploy] ([`3689b71`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3689b7171bea75d3465eb28e70e6fe29c7bde462))
- Bump version to 4.9.94 [deploy] ([`9f47759`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9f47759bdb2ae628a50b7d49ba204b6834288aed))
- Bump version to 4.9.92 [deploy] ([`279a728`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/279a7282be17abfb3df0277433d3f211d877bc57))
- Bump version to 4.9.90 [deploy] ([`8b05a7f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8b05a7fa6fa762f29e8dbf428cb7609198c0a230))
- Bump version to 4.9.88 [deploy] ([`a508093`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a5080932332b3569b828bc71854eceb640829ce2))
- Bump version to 4.9.86 [deploy] ([`1bf20ee`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1bf20ee39bf2aee4e39b868cfdfdaf52cffbbcbf))
- Bump version to 4.9.82 [deploy] ([`8be7041`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8be704145ef05b68d4425e98d75e12fb04d39dbf))
- Bump version to 4.9.81 [deploy] ([`14e22c4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/14e22c42c5ec21f1d5076b523fe2385940bd28b5))
- Bump version to 4.9.80 [deploy] ([`95f2aa2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/95f2aa273256843fb45205f3e3376f0c39926581))
- Bump version to 4.9.79 [deploy] ([`3fa1f37`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3fa1f37ac95f78501830c71751e5312677df112e))
- Bump version to 4.9.78 [deploy] ([`8959a58`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8959a582a82fb35731b67cdc11ab75750feb25ba))
- Bump version to 4.9.77 [deploy] ([`769d913`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/769d913abbac105044c54f5c2368e1febd5d261a))
- Bump version to 4.9.76 [deploy] ([`f8367a0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f8367a04d3923137e0bbfbf3cf9a991024ff42b1))
- Bump version to 4.9.75 [deploy] ([`30cb7dd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/30cb7dd14434025a0ce33bf4589fa8ca7f677338))
- Bump version to 4.9.74 [deploy] ([`21d7e47`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/21d7e47b8f79664d339e31d40b1aef673d776721))
- Bump version to 4.9.73 [deploy] ([`73a6365`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/73a6365f5f4d351a65b4f1af10054ff2ce097c25))
- Bump version to 4.9.72 [deploy] ([`87c9d74`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/87c9d74c2f3992c1ce2a3c34179c73f7d839e300))
- Bump version to 4.9.71 [deploy] ([`aa42660`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/aa42660694b2585dfb6335a092d90d844574e6d7))
- Bump version to 4.9.70 [deploy] ([`0e7eae6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0e7eae6232a73d271d444829020ac43d5286c354))
- Bump version to 4.9.69 [deploy] ([`37bd4a0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/37bd4a05591895cdd91ff986039cce04e787e7c8))
- Bump version to 4.9.68 [deploy] ([`da1f919`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/da1f91988ef59020a072ab3d05bbed59aef39132))
- Bump version to 4.9.67 [deploy] ([`3ec5d2f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3ec5d2fa2266cf3c33c39a093b948285e8be7e89))
- Bump version to 4.9.66 [deploy] ([`6f8b9a5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6f8b9a503484a12ad97d16f4e3b0e89aaae4c9de))
- Bump version to 4.9.65 [deploy] ([`72e2647`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/72e2647a7332a92377fbe2323dae4d0185b703a2))
- Bump version to 4.9.64 [deploy] ([`b2308ac`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b2308ac154e6759c9d932d57e278d2910163bddf))

### Documentation

- Record 4.14.93 coach-engine slice 3.I release ([`291eee0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/291eee0f27379e4e01b5fba05ff39ed1a0e131f8))
- Record 4.14.92 coach-engine slice 3.H release ([`710847e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/710847e68fc4f01044edf6fc355444b576306ed5))
- Record 4.14.91 coach-engine slice 2 release ([`f20147f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f20147f48c45006bce11e874192b43f58a2c53c9))
- Record 4.14.90 coach-engine slice 1 release ([`566ee1e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/566ee1eb75f9d3d872e093be785b3705a3a34dcc))
- Record 4.14.89 release handoff ([`05e3d3a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/05e3d3a4a4c6f07325b951c4728b7fe391df0ae1))
- Record training calendar sync prod validation ([`2731b06`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2731b06e7ab05d0ef432cbf606dec4f35a5af170))
- Update secretary audit release handoff ([`04881ca`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/04881ca96dd5aab035a753ed4f79f9ecc909fb5a))
- Update production truth for training cancel + rich description ([`87d2208`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/87d22086629ac37a77104db77fede34745eda65e))
- Add claude catchup protocol ([`165e361`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/165e361a93625bd0fdd81d110c25fd26c22522fc))
- Update production truth for training hardening ([`d1e5b40`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d1e5b401fa8b7cbd7d237bdbcf9a419722ce9a92))
- Update content script production truth ([`1af9600`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1af9600a804a571d00df94c08613ade70855a766))
- Update script cache production status ([`831e522`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/831e5229d54ccc667dd0441ff04e9ecbef6572a3))
- Update production content AI status ([`b8d1c26`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b8d1c26e825bc4f378bc35a1c2d2443c8719e6ba))
- Record beta deployment state ([`c0f91bc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c0f91bc060d3c7e806ee6c42fdc78ebd77e47f59))
- **beta**: Record production 4.14.67 ([`15dab23`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/15dab23920729934d7c1a7b06c3febc8b28bc5a2))
- **beta**: Close task list count priority ([`e219575`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e219575fc19097fc43f872fd91dbb8c282a3154a))
- **beta**: Record inbox latency deployment ([`5a0ef1e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5a0ef1e7ac1aa9fc434a6c63083a3d7b7320dc3f))
- Record production calendar recheck ([`f921642`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f921642f834be29e50e0cecf5236d68a70547519))
- Update beta production status ([`3f38136`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3f381366cd3a25fdda11189e564ea5ecaff0d34c))

### Features

- **coach-engine**: Slice 3.I — explicit experience-level resolution provenance (Layer 1) ([`6d4f9a9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6d4f9a9f24443db9f6acfea5e620e0422cb1a1b9))
- **coach-engine**: Slice 3.H — duration-aware strength target exercise count ([`4b16ba0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4b16ba0e47c63bed798dbf07ab971cca17c5124e))
- **coach-engine**: Slice 2 — beginner gym differentiation + explicit two-a-day preference ([`e8f85fc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e8f85fc0fe0c591990dff0a5447f64ee654aa450))
- **coach-engine**: Slice 1 — readiness adapter + calendar-aware scheduler + deterministic adaptation ([`3d35ecd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3d35ecdf1b24540cfe63534d25ff2271e4c564b7))
- **training**: Backfill calendar events for plans generated while OAuth was broken ([`8c6aaaf`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8c6aaaf8f100a39a16472f30caccdecdc70213cf))
- **training**: Hard-delete cancel + rich session description ([`688d30e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/688d30e138c8c3ad2e206e13abc92bf0999f4941))
- Upgrade secretary orchestration and home briefing ([`39c43f9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/39c43f9314aaa70229c5608058a35cb2b6b72d47))
- **coach**: Persist kernel plan + live-readiness re-adjustment for today-aware guardrails ([`bc9cb53`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bc9cb538570411a6a0a679125f7c42660ad28a6e))
- Coach kernel + screen contracts + deterministic home view states ([`0ab36d4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0ab36d459532624e0f664754acf24d32b91575f8))
- Audit cleanup + cross-skill intelligence mesh ([`f1d423a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f1d423a922292d7df144f6f247deb15ebf15e77c))
- Ship tenant-safe orchestration and content hardening ([`f3ba48b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f3ba48b0b038be84b53ab23aaf23cfb93288fae2))
- Portal model pricing table + model intelligence insights ([`a645152`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a645152e8470fe345a34fef14c3daa41bf389ef1))
- Secretary domain → GPT-5.4 nano (91% cheaper than Claude) ([`200bae4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/200bae46f906b741fdaa20f72d640414e644284f))
- Python engine hardening + metering + deprecated paths removed ([`c2aae43`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c2aae43841a3127573216e55be20a1acd1d4f32f))
- Dual-model receipt verification — Gemini + OpenAI cross-check ([`1f85e39`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1f85e39c65437406f8112003cad17502b9c1f3d4))
- JWS signature verification + task list move endpoint ([`ac38e29`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ac38e29e9ef5aed5928299d16a078bb2ba0b1268))
- Deprecate Telegram runtime — iOS + Portal is now the product ([`539458a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/539458a999e9a0479559c9df4cb56908d703634b))
- Founders system — permanent Pro/Max access by email ([`d7d4a5c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d7d4a5c14dc3b399b1fa6d72e1233de9df7e0f91))
- Real generation modes + explicit userId in content personalization ([`507aae9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/507aae9681d4950dd42433320f9c085095eb9cb4))
- Release hardening — validation-first deploy, latency telemetry, docs refresh ([`7be1901`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7be19016ae2fadfd7ebc704a047d618e0436ee84))
- Apple Server Notifications webhook + residual risk fixes + checklist toggle ([`ad967a3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ad967a348d223b2e000650d7f17a03640245da2b))
- Google OAuth PKCE flow — replaces deprecated implicit flow ([`f7410f1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f7410f19895b92886b3dad97170fae86360dcf30))
- Generation modes/metadata + docs iOS-first update ([`b7c4097`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b7c4097478f2fe52bfc3ed81fdc10870e239b77b))
- Generation modes + metadata in script response ([`3af578c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3af578c1550d95e3b7fa89360865297ad79c8a93))
- Script hashtags/caption/CTA — full creator-pack pipeline ([`03611c2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/03611c2625d409cdc24ffac1a7e9ca65829e0112))
- Apple Health parity + unified inbox + push preference routes ([`d9f2c97`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d9f2c9735253569aade506e8bda807d5a39ee44c))
- Durable reports + push preferences — app-first architecture pass ([`13be6da`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/13be6dafec827a1768a391fd2918362b6c4b8959))
- Durable content notification inbox — remove grammy from core workflow ([`043cc27`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/043cc2715780642e3cf46e19599ef4b984d77fde))
- Signal ranking, pipeline metrics, workflow scoping ([`c5f2cac`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c5f2cac8f3384347d4b01ede2d35f6de1aa6ad40))
- Canonical DB-backed content learning store ([`430b171`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/430b17148c246b5707f1e74509681db216d47b68))
- Complete multi-user data isolation (migration 057) ([`4a569c9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4a569c9804d4ff9befdc2f69a5bcdad6488ab59a))
- Session 3 — iOS content sync endpoints + Body Battery verified ([`ecfe723`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ecfe723a53e82f365a0ff11f567d75da1ff12df7))
- Per-user content enrichment isolation ([`9fbbd05`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9fbbd05a8d8e9d02c25974055a50c47331cc0c45))
- Config migration to DB + content-engine health check + retry ([`679f15f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/679f15f64bf958410431df9f3eaf5da7d3792bd3))
- V4.10.0 — Garmin per-user auth + Quick Add + portal write ([`6baa2fb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6baa2fb8acb006e1b34fe888aaf2ec5b113e9798))
- HealthKit Phase 2 — Apple Health coach fallback ([`661ff93`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/661ff93a2dad81bd388c13802e72794e0b281e5f))
- Training plan enhancements + OCR item validation ([`85c3fb9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/85c3fb9122caaa6a6b65f084657a44fc77e04f8c))
- POST /training/plan/generate + receipt OCR prompt fix ([`9369718`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/936971821130976a27425f9fcc8205e30a7c14a2))
- PAYWALL_ENABLED toggle + fix onboarding answer field mapping ([`a6ce459`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a6ce459a0cde17aa0e635ef7fa58d7c4f017674d))
- Per-user greeting + POST /tasks/lists create list endpoint ([`c292d2e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c292d2e9f74eef49e490a063ea443e566a174980))
- **billing**: Margin-safe cost caps, soft usage labels, no free tier ([`92fd259`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/92fd2592cb5df2ff4e513b6f8544e2095a288c61))
- **billing**: Plan-based AI usage limits + usage endpoint ([`a00a873`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a00a873fd3047f2a7ec26cc9dc9a02572487d13d))
- **auth**: Google iOS Client ID validation + audience check ([`ebde812`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ebde8122d172bd9af894708cabca484783c0aac0))
- **tasks**: Native SQLite task system for users without MS To-Do ([`0bb5b28`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0bb5b28637ea148ac50bfe3dce2693c93a72e814))
- **auth**: Email verification with 6-digit codes via Resend ([`02e71e8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/02e71e852b2e8882b7f305a9add3766339720a85))
- **isolation**: Per-request user override — complete multi-user data isolation ([`27b9867`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/27b9867535504713c5c8c91e469d8653f9d23e26))
- **auth**: Per-user Google + Microsoft token resolution functions ([`c131330`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c1313307d46ae83d445e10aa762748b3e4ed37b7))
- **oauth**: IOS-native OAuth flow — initiate endpoint + callback redirects ([`d77d013`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d77d01360ab2270b2557105e3c3970dae696da32))
- **auth**: Multi-user registration — Apple, Google, Email/Password ([`0d88982`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0d8898264ec0a89959d16a9256f234aee0b76605))
- **billing**: Add BRL prices for Brazilian market ([`ab7cddc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ab7cddc0cd81a8d29232733373a00fdb6afccf60))

### Performance

- **inbox**: Use local task read model ([`cc40b1e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cc40b1ea14c835f31255a034b198a42c37ae2d35))
- **inbox**: Bound unified inbox source latency ([`a590006`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a590006651c30a6dc82eceb96d0e4f06b6dbb50d))

### Refactor

- Rename botStatus → serviceStatus in dashboard + settings API ([`8b6ff28`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8b6ff28074e8f93f27bdba8ccf905c2969155d82))
- Remove Telegram-era naming from prompts, descriptions, system docs ([`0d52a07`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0d52a076ff354d3275498a2a85205f11d60b857d))
- Physically move Telegram formatters out of core content-engine ([`6179708`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6179708feb22bbc3f87b9257f5289ab9c8df5da3))
- Portal uses canonical content services — eliminates SQL duplication ([`225b891`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/225b891b7c791c74be72792f891d0edc4826c666))
- Centralize creator config, extend eval suite ([`30baaec`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/30baaec8f9197e48e60e697eba6ceb6536b3dd6a))
- IOS-first content architecture — decouple from Telegram transport ([`a2fc28a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a2fc28ae9b6b9a245547163734f37148636c79b4))

### Tests

- Skip 9 pre-existing adherence-signal failures (DB seeding issue) ([`e1176b7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e1176b78565efd1c67ff92c16a11d6aa6ffb07cc))

## [4.9.63] — 2026-04-10

### Bug Fixes

- **garmin**: Silent mode for iOS API routes — prevent MFA email flood ([`b335ee8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b335ee8a307377acaf3f3a424e1ee614436905e8))
- **bot**: Add /readiness shortcut — alias for /training readiness ([`a32a0d2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a32a0d246ae27577724500a73465d8f855fafa0a))
- **landing**: Pt-PT → pt-BR cleanup — 24 substitutions across strings ([`2a8bf15`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2a8bf154c34970ad65f3f8094e93a88117753761))
- **cost-tracking**: Persist user_id in api_usage INSERTs — unblocks per-user cost cap ([`795aee2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/795aee2a5b02b6bb553fd864e90c7bd4d028f661))
- **garmin**: Silence training_plan_adjust cron to stop MFA email flood ([`866c049`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/866c0491380feb5068f1bf7bde39cbec08a776f6))
- **garmin**: Stop daily MFA passcode email flood from coach cron ([`4eda31d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4eda31dc84a8e6bb1bf49dda078c8a678d98bd83))
- **oauth**: Stop audit_trail bomb — cache decrypted tokens + retention ([`cfaf80d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cfaf80df12398cd3c2f765a3212a281eb1d8ae65))
- **portal**: Expose loadCostByDomain on window so inline onclick finds it ([`e815dd3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e815dd3e830f8a85d1a6827e9f228ad8181df8fb))
- **garmin+portal+ios**: MFA flood, cost range toggles, per-user skills, ios calendar POST ([`11d0630`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/11d06309fa51a5383a813d67ebc8d4011c165bac))
- **model-config**: Remove non-existent gemini-3-flash from dropdown options ([`6b10d77`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6b10d773c0ca0c013749cbe92b33ab956324f90b))
- **staging**: Allow empty allowedUserIds + fix shell pipeline health check ([`0983246`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0983246b65ba8ea6d85d6dd2fb08122e80c5d4ef))
- **tracing**: Contextvar leak + uvicorn logger override (Quarter) ([`9c01e0d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9c01e0dcc3b2577902bda582734701e2c4ee1334))
- **deploy**: Backups now include bot.db + new restore.sh script (QW-10) ([`d15c253`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d15c253c53512152c4920d9a29b1a28bc2f7eb39))
- **stability**: Error handlers now graceful-shutdown + deploy waits for port drain ([`45359f4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/45359f4d85d2a4162a7482a386468d47fc987c96))
- **gemini**: Default model name was non-existent — heavy tier was 100% broken ([`156b893`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/156b893ff077cee92db6b33e0d3a88f3fa7b4cee))
- **routing**: Wire createRoutingProvider() at startup + Domain Routing portal view + include-secretary flag ([`55e77d7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/55e77d755172d1f81e2eecc825dbaea0987cc500))
- **landing**: PT-BR translations + restore admin portal at backend root + CORS waitlist ([`b99b1b1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b99b1b14cc69f8e7d42c180e16f28fa61855c8d6))
- **tasks**: Default-list fallback + stale-while-revalidate cache (v4.9.14) ([`a38dbd8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a38dbd8fc1898dc57a19cf8dc0f158f74553b3fb))
- **api**: Tasks create + training complete broken handlers (v4.9.11) ([`43607c4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/43607c47afe82ff3ef59dd4d3dd29ec9b9102c05))
- Increase chat timeout 25s→40s, clear stale TZ caches (v4.9.5) ([`9bda8fb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9bda8fb92e149fb9e3c89182f6ec9666ff8d5ef9))
- Filtered task endpoint, dynamic timezone, overdue fix (v4.9.4) ([`b682fa5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b682fa502f4f9ea50d56cb9276ad9d19edc5d20b))
- 7 code review findings — security, correctness, robustness ([`bc32ac7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bc32ac7ceb2e106fda995673e7d6c7134f4f3329))
- **api**: Normalize bodyBattery at assignment, not just return ([`aae661e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/aae661e1742175f3708f931a9d514412897f2c9c))
- **api**: Normalize bodyBattery at response boundary — always return Int ([`3b6d752`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3b6d752e2c27988233b94c3f9ce28f47807da588))
- **api**: Normalize bodyBattery to Int — Garmin returns object not number ([`f27a33a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f27a33a2182276939365062909feb6360b0cc01b))
- **api**: Dashboard and training route improvements ([`9dd70e9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9dd70e90ee768da44303acb2e1557811a9f1d216))
- **portal**: Remove stale window.updateModel reference — was crashing entire IIFE ([`155eae0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/155eae02eee2ddb2b366f77516c9ca620764d377))
- **portal**: Simplify auth to sync check + add debug logging to poll ([`f4a30c7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f4a30c723f7a88bb5c0d7f9cc521719dd0bc541d))
- **portal**: Server-side token injection — portal works without localStorage auth ([`3c63d38`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3c63d38f4fcbf9c19524175b9bc402f8e9a0d828))
- Portal auth validation + correct getTasks signature + chat timeout + refresh token rotation ([`7be7d3b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7be7d3bc89c4774430abe35ce4f2b5f65319b0c9))
- **api**: IOS API route improvements — auth, chat, tasks refinements ([`cd17adb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cd17adb1d9d1814a8794ddbf31292e9932272007))
- **portal**: Gate ALL polling behind auth — fixes connecting... stuck state ([`74f4897`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/74f489760932ba51ba0b0084b9e267b443684a85))
- **portal**: Add no-cache headers to portal HTML — prevents stale browser cache ([`07fdfb1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/07fdfb11bbe731b8350a1c6fc552bc09b3b98806))
- **portal**: Replace prompt() login with inline form + URL token support ([`52d6ad3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/52d6ad3de6b8ba1107811eb72d7ae78247dc42ff))
- **api**: Add public /api/v1/ info endpoint — no auth required ([`c5001a1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c5001a13f71d7fbff65efb05cb2f63c896f5a9da))

### Chores

- Bump version to 4.9.63 [deploy] ([`953de81`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/953de8107594954bd947e6d6d4f7078c24fefb4f))
- Bump version to 4.9.62 [deploy] ([`2a1490e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2a1490eea73bec7721bb2e7b88fad33b8e1cc697))
- Bump version to 4.9.61 [deploy] ([`ef6caa4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ef6caa47bd318fa4ec5a25a7b6d33744d6d1d185))
- Bump version to 4.9.60 [deploy] ([`5ab26db`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5ab26db923d9a12a29aea37bc0a9e2741e3ded17))
- Bump version to 4.9.59 [deploy] ([`62993d6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/62993d62a2331ee58448ef06a163bdf692228a6b))
- Bump version to 4.9.58 [deploy] ([`a835ade`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a835ade675e0945cd1df1fb86150115ea30e8fb0))
- Bump version to 4.9.57 [deploy] ([`7f9d0d4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7f9d0d4607af9d33d8b614fda564dd9939e6ac9c))
- Bump version to 4.9.56 [deploy] ([`abb475e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/abb475e188710c56ad742a88a3b6b512a5b38f46))
- Bump version to 4.9.55 [deploy] ([`d1550dd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d1550ddefdfdbf3bf019668ed800b5673a754986))
- Bump version to 4.9.54 [deploy] ([`4c117ce`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4c117ce8a506cb60c861c42eb2823c101ba29fdf))
- Bump version to 4.9.53 [deploy] ([`2546dfe`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2546dfe4105f396fbeb78172cb336d48236ffdc6))
- Bump version to 4.9.52 [deploy] ([`82080f5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/82080f54542966150a4d2e52a34ab2592e0a5d59))
- Bump version to 4.9.51 [deploy] ([`23b148c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/23b148c55052f790eaee1f0314ce6f5b85f03849))
- Bump version to 4.9.50 [deploy] ([`ddb5790`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ddb579074689f34a40b9f9108dd9ca3a52f2905b))
- Bump version to 4.9.49 [deploy] ([`d18e102`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d18e102cad5737d739241b22485361db0fa5fdc5))
- Bump version to 4.9.48 [deploy] ([`cae43e4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cae43e41819b47c9a73edec4b566298d3bbc4d75))
- Bump version to 4.9.47 [deploy] ([`fd836f2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/fd836f2f6040ac204427b08944bc19ab99346aed))
- Bump version to 4.9.46 [deploy] ([`2182774`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2182774f50d1dcfc6023b86620b477f4a3dffcf7))
- Bump version to 4.9.45 [deploy] ([`cf2d7c8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cf2d7c8b99f3863f36bc9c0bad8baab8945b1b60))
- Bump version to 4.9.44 [deploy] ([`86eee34`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/86eee3495336f845ea0c3caa8dc2c912f89bb635))
- Bump version to 4.9.43 [deploy] ([`48d79f5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/48d79f56deb9ad3fddfe4ba194bfc32995d7a120))
- Bump version to 4.9.42 [deploy] ([`1ebc524`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1ebc524592cd7c35093f37c7b3806ea7bd935a4b))
- **phase-0**: Cherry-picks + orchestration cleanup + gemini defaults ([`be3b806`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/be3b8065b5a2b3db3190878e5af995c8bcb634c5))
- Bump version to 4.9.41 [deploy] ([`369bc98`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/369bc98520a989583b4aa94785922081db396d09))
- Bump version to 4.9.40 [deploy] ([`09ea8df`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/09ea8df6bdec1c26b07b8d0abe30cc0abeaf5039))
- Bump version to 4.9.39 [deploy] ([`11bb8b3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/11bb8b33d330108fd30a21c7e014143768a1914f))
- Bump version to 4.9.38 [deploy] ([`48ba2b6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/48ba2b68f75abce748bc8b9c08d1e1f4752620ab))
- Bump version to 4.9.37 [deploy] ([`6acf73a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6acf73a77e33a02337f58fb4535f87def558d272))
- Bump version to 4.9.36 [deploy] ([`09017f6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/09017f6fd328824e5f12410e1bf87f7334c73071))
- Bump version to 4.9.35 [deploy] ([`08a5df1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/08a5df139b7686a8b9a6606e5c4622d4325fb422))
- Bump version to 4.9.34 [deploy] ([`489129b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/489129b368962b424d2d404aeb54bd493a212e9b))
- Bump version to 4.9.33 [deploy] ([`bba0eb2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bba0eb2129280515b3e4c05807ef67cc6e4386b6))
- Bump version to 4.9.32 [deploy] ([`811600d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/811600d77f43420e8f450217c7207175ac2c23d0))
- Bump version to 4.9.31 [deploy] ([`add409a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/add409acd7b84ae11c3f8d977b5208c641f79355))
- Bump version to 4.9.30 [deploy] ([`23baf74`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/23baf74cc34cc82e16c178711ba9a1e6d9e09722))
- Bump version to 4.9.29 [deploy] ([`9ac0181`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9ac01814bc0930f7beafa29082e6787bbf38e665))
- Bump version to 4.9.28 [deploy] ([`f4c5203`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f4c52033644335a4b620059f5114a04f3548655c))
- Bump version to 4.9.27 [deploy] ([`c666693`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c666693596fcaec3875fa898b91c90a7b49a8477))
- Bump version to 4.9.26 [deploy] ([`cbc7451`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cbc7451fb1840efb38705ef9eb6cf173228280a8))
- Bump version to 4.9.25 [deploy] ([`9d672d7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9d672d795583566bd4bf8c2fb6328d0a96c0818d))
- Bump version to 4.9.24 [deploy] ([`2fb83ef`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2fb83ef9f65732aeed3e597ed165c6de6b123906))
- Bump version to 4.9.23 [deploy] ([`e5952be`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e5952bef6dafdfecec94f2e3435778a815276408))
- Bump version to 4.9.22 [deploy] ([`e1913c1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e1913c17a04fbb34f13ce4c26ce70d73316d5b5c))
- Bump version to 4.9.21 [deploy] ([`615adca`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/615adca13a4ea42da99663e80de0d7e44f1d1656))
- Bump version to 4.9.20 [deploy] ([`424a340`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/424a34069d8f5882cd49e836ab5170c415c1ffbc))
- **audit**: 8 quick-win fixes from end-to-end audit ([`bea1855`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bea1855d7fba32c82690781bceb0f9fbf5781706))
- Bump version to 4.9.19 [deploy] ([`56435fc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/56435fc952066d35b7966edfc25d238321590905))
- Bump version to 4.9.18 [deploy] ([`5124f4f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5124f4f76a1440254aa9d7c247696d3916a31185))
- Bump version to 4.9.17 [deploy] ([`506808b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/506808badd7cc09f3f621c6017365736aa67f57e))
- Bump version to 4.9.16 [deploy] ([`9964131`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9964131705c4feb822c65ebaf72f15216d5d71e9))
- Bump version to 4.9.15 [deploy] ([`f7d7df7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f7d7df7a0f5db57bff69635e713ffa00008c30a7))
- Bump version to 4.9.14 [deploy] ([`521ebf9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/521ebf94313d73deae3d7a5b042050589e3a8143))
- Bump version to 4.9.13 [deploy] ([`69a1286`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/69a1286ffefe446ed976c109847d5aa373e9d7cd))
- Bump version to 4.9.12 [deploy] ([`b4ba315`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b4ba315d92c8ab92fb535aa3e3c28d70397966e7))
- Bump version to 4.9.10 [deploy] ([`8cb51df`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8cb51dfb45f6fe85684a264c37587803024cc3db))
- Bump version to 4.9.9 [deploy] ([`e6484d3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e6484d369f8c28b4525283b8a150d2e90514063b))
- Bump version to 4.9.8 [deploy] ([`8645051`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8645051938fc583624fae76cf172e0c134dd0bb8))
- Bump version to 4.9.7 [deploy] ([`fbbeb17`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/fbbeb17a6e3323d3ceb05c147ad460f43f66f738))
- Bump version to 4.9.6 [deploy] ([`920692a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/920692a0515ab0f2cf022a9f8796f4eb564aca8f))
- Bump version to 4.9.0 [deploy] ([`3293faf`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3293faf0546a9311b3ba7e8d1e2e417de6ea14bf))
- Bump version to 4.8.25 [deploy] ([`b0c476d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b0c476d9df721683550c1e19a08ebf2c1cf57250))
- Bump version to 4.8.24 [deploy] ([`2a0fa80`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2a0fa8043df00ce37d4a3ebe67bb6141b13a4eaa))
- Bump version to 4.8.23 [deploy] ([`a9d8a37`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a9d8a37bebed7395a65a2d241afe16ca676776d1))
- Bump version to 4.8.22 [deploy] ([`059740d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/059740ddd006fc1c2fc2465d987dbad4c8a22de6))
- Bump version to 4.8.21 [deploy] ([`e4944ce`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e4944cea772f104f4e198544832a9bc34c5bbea8))
- Bump version to 4.8.20 [deploy] ([`33f071e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/33f071e951751acc1e1c7ae99c0505249de6ae8d))
- Bump version to 4.8.19 [deploy] ([`299550b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/299550b4f6218e2fcc0f5ec22077da8a1a997ceb))
- Bump version to 4.8.18 [deploy] ([`c97bce8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c97bce827d491a02eee771fd44730ecea6f85338))
- Bump version to 4.8.17 [deploy] ([`78d0991`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/78d0991c20f9676a09ecd3acb51a9d713d02dd9e))
- Bump version to 4.8.16 [deploy] ([`e461f37`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e461f3743daa1e8284f9267dcbe0da67e6361107))
- Bump version to 4.8.15 [deploy] ([`2ab5d9d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2ab5d9d29cfedfe0b910914ebf46df6dc398aef6))
- Bump version to 4.8.14 [deploy] ([`a8adb16`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a8adb16d9b45e6e14940b1bf20564d75beb37bb0))
- Bump version to 4.8.13 [deploy] ([`a822989`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a82298973f9886823745981055faa56ce86a6513))
- Bump version to 4.8.12 [deploy] ([`54eed40`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/54eed40f981992683e847ffa91bfb74c37caa832))
- Bump version to 4.8.11 [deploy] ([`be8f9d0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/be8f9d0b150b0e6f4c31541bfcbca635c249425f))
- Bump version to 4.8.10 [deploy] ([`09d8b88`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/09d8b884b690cd6e0a617300f8195d7ad0886b23))
- Bump version to 4.8.9 [deploy] ([`12367b3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/12367b3c1a4d6f930ed4eb69faf658f7d134fde1))

### Features

- **billing**: Stripe + Apple IAP subscription system ([`007e373`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/007e3736ccf02f8a529480573242c67dd33ba1f8))
- **portal**: Content admin editors — books, channels, pillars, voice DNA forms ([`b729e74`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b729e74a3f632f923ca54a55f310f71ecb351f1d))
- **health**: HealthKit Phase 2 — sync endpoint + Body Battery synthesis ([`3a07d67`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3a07d676e1d5ff44003d01bc37f6542938ef4d89))
- **portal**: Content admin write surface + Channel Re-Learn fix ([`62d8e98`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/62d8e9847a8869ac67d6dc88ecdb80f1abcbb38c))
- **apns**: Phase D backend — APNs push notification sender + cron wiring ([`e1fe45c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e1fe45c16ed85369b83fef9d75650e5e8f49e5cb))
- **landing**: Option G pricing rewrite — Hybrid Operator positioning ([`65be674`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/65be674a4f090db6138656097a3cd9b55e438c19))
- **cost**: Hard-disable Anthropic API + flip fallback chain to OpenAI ([`d8231dc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d8231dcb0829611ffa63da46bdd2a0ede7ae3a97))
- **portal**: Restore Content tab UI with 8 subsections ([`a85d6ac`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a85d6ac7f086c3fc0def23c7c6ff7e864405dc35))
- **portal**: Restore content dashboard admin endpoint + tests ([`4c86c77`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4c86c77c79b4c295e919b9919872742ca8f265d6))
- **cost-breakdown**: ComputeUserCostBreakdown — per-user cost aggregation for pricing calibration ([`7b1fb03`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7b1fb03e83c1e6edb45967b2499da6821a59afe0))
- **cost-tracking**: Thread userId through iOS chat + receipt parsing + classifier ([`3f0acd9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3f0acd946ece094d21d7da4339870eff7299c0bc))
- **api**: Finance PATCH tx + receipt parsing via Gemini vision ([`c8c434f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c8c434f2a93fcd0586af6fe994d0717bb5cd474a))
- **api**: Cooking recipe edit + meal-prep calendar events ([`a2bcdbd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a2bcdbd62ee9b9fb96fb977371859d101914ed01))
- **api**: Content topic scheduler — CRUD routes + new DB table ([`5e16efd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5e16efd6aaa36e4d87f123925cc492940b27e4ad))
- **api**: Notes PATCH + DELETE + extended list limit ([`0613d4a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0613d4a5fc1ed50a29ec52ab6cab420c52f59560))
- **api**: Phase 1 foundation — cooking / finance / invoices HTTP routes ([`c3963de`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c3963de9350770563023071601b73764bed2eaad))
- **phase-3+4**: Cross-skill signals + progression analytics + plan drift ([`2822183`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2822183f0e6b87d06072a64ab2977d886957a21c))
- **cost**: Port classifyAndExtractImage (photo classifier) to Gemini vision ([`8a07b86`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8a07b86cad58c366e4fc6549383cd101a026e590))
- **cost**: Route classify_message + invoice vision + content discovery to Gemini ([`bb52d05`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bb52d05fa47f78a2e4882f658f4b1573f2508d25))
- **cost**: Route content_workflow_* topic generation through Gemini-first ([`0362205`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0362205b2bcaf795a4549209f269d6f42b14b561))
- **telegram**: Opt-in webhook delivery mode (Month 2) ([`7878f55`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7878f5561c9a3c11c6e936e10bdddaca678ce6b6))
- **deploy**: Blue-green-lite validated promote pipeline (Quarter) ([`c369af0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c369af0382bd515cc8bdd62a3bfaa35dc77bc2f9))
- **staging**: Isolated staging environment + deploy script (Quarter) ([`daa6b95`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/daa6b95d8ba2970a05d3e020bcd5d1a3419d8ff3))
- **tracing**: Correlation IDs threaded across all entry points (Quarter) ([`ba37eed`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ba37eedf2c6d3a97e888c50cc59c4e28d27c2850))
- **portal**: Per-endpoint cost dashboard (Quarter) ([`e55f68c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e55f68c92c41534a3178a0c08701808858c51597))
- **ops**: Tested rollback procedure with dry-run mode (Quarter) ([`eb6568d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/eb6568d80c27fc96cb3a2e11c285ad9aa0072a18))
- **month2**: Parallel task sync + LRU cache bounds + Google SDK timeouts + DB transactions ([`cc80146`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cc80146f623128fb6353a81c6d5cdc357169c2d9))
- **weeks2-4**: Retention + FK constraints + health probes + req middleware ([`a3c7721`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a3c7721ed897ef0e0202e21e1b7596b7822e91f1))
- **api**: POST /api/v1/client-errors for iOS crash + error reporting ([`7792490`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/779249055d2b52932f49c94f537814aeaf502296))
- **landing**: Bilingual PT/EN landing page + fix missing landing.html in dist ([`fde8417`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/fde8417dd3e237e608d1409577b53abfb544b6ef))
- **landing**: Nexushub.me landing page + waitlist backend + admin portal tab ([`f75584a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f75584abc077292948c55746ff55de09c064957a))
- **tasks**: Todoist + Notion task provider adapters with OAuth + webhooks ([`04d41a8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/04d41a835dadcf46de05d4e8a91633b5ebd11c8a))
- **tasks**: Unified task store + sync engine + cross-domain context engine ([`b3c0c8b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b3c0c8b0a1b1476a50b8b98ef6fcecf45e4c4ed4))
- **routing+portal**: Enable Gemini by default + cost-by-skill + dashboard provider fallback ([`841d49d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/841d49d0a88a3bdb0392588780fc0dd1fe306ea2))
- **portal**: Admin portal UX overhaul — management tool best practices ([`6f3732b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6f3732b0b080c9d3df7f9037aa2c7df16b75f26f))
- **api**: Complete token-zero REST API + standardized response format ([`7270401`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/727040137b1d093c69578ef93a10ac019dc18b2e))
- Complete multi-AI provider implementation (Phases 0-8) ([`a1c9213`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a1c9213163c2496ec2152554522a306e2ee51aba))
- Multi-AI provider routing — Gemini for non-secretary domains ([`da14122`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/da14122afb0be49bbb41dd9502b11a65a3548bd4))
- Token-zero architecture — SQLite cache, ETag, classifier fix, cmd cache ([`2eb3d19`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2eb3d197859d1762eac5917f60f6ec623997431a))
- **api**: IOS API improvements — rate limiter, expanded routes, dashboard enhancements ([`a60b644`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a60b644788a24bf812f2b680af49c39b6718d7e5))
- Add iOS REST API layer (auth, chat, dashboard, tasks, training, onboarding, settings, content) ([`22fc325`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/22fc32591e99764238969be3070ef619ded028ba))
- **portal**: Version display in header + confirm-before-apply model changes ([`b6ec846`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b6ec8466ff7b20db6754eac0842506684671afc8))
- **portal**: Show running version in header ([`4bbc1d4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4bbc1d4588839bc9ed26da26376bfb5ee58a40fe))

### Performance

- **secretary**: Layers 2-4 — smart context, dynamic tools, adaptive model ([`e5bbf47`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e5bbf4775acafc4da49342a2c7ab6045b81d4ef3))
- **secretary**: Layer 1 — command fastpath for zero-token data reads ([`03a5a56`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/03a5a56600f94b0d6a6099cd2db9af2e4975dd15))
- **gemini**: Migrate 5 more single-shot AI calls to Gemini-first ([`e08ce8d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e08ce8ddd61707aaa8e3dd177fdf7e7244828ce2))
- **coach**: Route coach_analysis through Gemini (5.5x cost reduction) ([`1bb2948`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1bb294850c19c17d35c834187b04e7d613efc677))
- **secretary**: 4-layer token optimization — fastpath, smart context, dynamic tools, adaptive model ([`d299f70`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d299f704026ad1169e95e7c4f9e6404e841e4595))
- Dashboard cache, timezone fix, overdue tasks (v4.9.3) ([`18804dd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/18804ddd95fb8aef45441634e474d03cfffbc142))
- Background task cache warming + wire quick actions (v4.9.2) ([`8e9e0d6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8e9e0d609eb8d272d1c3e5a5ba61c3a52789b3a6))
- SQLite task caching + fix version display (v4.9.1) ([`0245ec0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0245ec07748068524aecdcc36006f2cc6321410f))
- Cache coach briefing 6h + readiness 30min to avoid AI token waste ([`1d8666e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1d8666efd1d239246654b28c78813f435188970b))
- Remove N+1 task count queries (12s → <1s for tasks/lists) ([`888f25d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/888f25dd640ee97c802e52e1b21f6fcd697f4b1f))

### Refactor

- **radar**: Read pillar keywords from config_pillars DB table ([`4342bbb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4342bbbc5f8d1d5cebbc74010110a32a502129fd))
- **routing**: No Claude as primary — every domain routes to Gemini ([`339c43e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/339c43e29a78dc89f70c27fc37d87f1a79276f4e))
- **routing**: TASK-17 Option B — provider-agnostic L3+L4+L5 + route secretary through TaskRoutingProvider ([`568e84a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/568e84ad8c1eb3bc36728b4d5857ca9d7f2cd5a2))

## [4.8.8] — 2026-04-04

### Bug Fixes

- **polish**: P1 first-week fixes — splitMessage, help text, i18n, error handling ([`0e45472`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0e45472044531d7f9b02105f9e2faae8feec3cee))
- **critical**: P0 alpha blockers — data isolation trigger, scheduler multi-user, cost guardrail enforcement ([`1c8f585`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1c8f5853c133ca40c577ab23cc4609d91045a7f9))

### Chores

- Bump version to 4.8.1 [deploy] ([`09e9dd5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/09e9dd5cdaec58b36cf612016c941911417710b8))

### Features

- **onboarding**: Skill-gated questionnaires + post-registration auto-onboarding ([`b3ba389`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b3ba389fac992005cf34ba88c1b3c65bd1c64774))
- **fitness**: Multi-wearable abstraction layer — Garmin + Strava + Whoop + Fitbit + Apple Health ([`d2a1543`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d2a154350763a65d14f29421a8b170772bfee071))
- **fitness**: /training commands + planned vs actual comparison from Garmin ([`a987a53`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a987a533e187945b6463881376a1ee6d49eb9c0f))
- **fitness**: Readiness scorer + AI plan generation + calendar blockers ([`9d2b4e9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9d2b4e9e7f4e1bfdfb33badc057be78d68fb90f4))
- **privacy**: Full GDPR export/delete — all user data, audit trail, /export + /delete commands ([`34fc56c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/34fc56cde72a5c33f8710654b52eb2a6acbe0926))

## [4.8.0] — 2026-04-04

### Chores

- Bump version to 4.7.12 [deploy] ([`9594508`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/95945087ae5d1ade2bc3e46b1fb242a11c71c808))

### Refactor

- **bot**: Phase 5 — extract callbacks + media, finalize composition root ([`01f53b3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/01f53b395a6f3cbefbd32cfbc66794419066a639))
- **bot**: Phase 4 — extract content + finance + triathlon + system + skills commands ([`14cba34`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/14cba341eac50bae9cda881bec3a7c794d103b0c))
- **bot**: Phase 3 — extract secretary command handlers ([`e731b17`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e731b17d60bfcc0ece973ae01ac901a7eb283984))
- **bot**: Phase 2 — extract post-createBot helper functions ([`7fab4f5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7fab4f5abe9b739dcf122acfc2fdbfe29814c72f))

## [4.7.11] — 2026-04-03

### Features

- **agents**: Wire Book Extractor → Voice Evolution + expandable Voice DNA cards ([`9aed5a2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9aed5a24e38e35c90985ea2934732c81d2d4dffa))

## [4.7.10] — 2026-04-03

### Bug Fixes

- **portal**: Async render function — fixes portal showing no data ([`33ea0cf`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/33ea0cfae92337129db01d377ec1fe7006224b7e))

## [4.7.9] — 2026-04-03

### Features

- **content**: Reduce Reaction Radar to 3x/day + show extracted voice DNA in portal ([`781ebf7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/781ebf7fc66697fa89fc805f7879ea469f134448))

## [4.7.8] — 2026-04-03

### Bug Fixes

- **portal**: Mesh signal visibility + layout + missing edges ([`755fa19`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/755fa19b3556e211eb6e8fbb680d995e214d2ca7))

## [4.7.7] — 2026-04-03

### Bug Fixes

- **skills**: Seed installed_skills table on startup — fixes skill toggle errors ([`cc9173a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cc9173ae7faf2606e5637e8357d8deb960827f95))

## [4.7.6] — 2026-04-03

### Bug Fixes

- **portal**: Sub-skill toggle error + master skill toggle switch ([`6c6dc04`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6c6dc043957e06c959fdd7a8540353f887e4ebe3))

## [4.7.5] — 2026-04-03

### Bug Fixes

- **portal**: Improved agent mesh UI — curved connections, better contrast, brighter nodes ([`0bd2933`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0bd2933ea4b8c48830c7cba62eda4835c33f0dde))

## [4.7.4] — 2026-04-03

### Bug Fixes

- **portal**: Expose button handlers to global scope — fixes invite codes, skill grid, model config ([`42df9a0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/42df9a03d27a5b6c02d458a0cada9c930e02599a))

## [4.7.3] — 2026-04-03

### Bug Fixes

- **timeout**: Auto-scale AI timeout to 90s for streaming/Sonnet calls ([`ceda18a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ceda18a48a417e93e0a6609af8f47d1c7d47c324))

## [4.7.2] — 2026-04-03

### Bug Fixes

- **portal**: Tabbed layout, skill defaults, invite codes, sub-skill errors ([`9e2aeb0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9e2aeb0b89973ea2c263e33ed2d7af805381d395))

## [4.7.1] — 2026-04-03

### Bug Fixes

- **portal**: Replace undefined authHeaders() with existing apiFetch() ([`4e9df61`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4e9df61ba536ae43899b3a3a085cc9fcf59be064))

### Chores

- Bump version to 4.7.1 [deploy] ([`801fe3b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/801fe3bbbb00c26983484c7a4d4981229163953b))

## [4.7.0] — 2026-04-03

### Bug Fixes

- **portal**: Handle EADDRINUSE gracefully — don't crash the bot ([`329d877`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/329d877312af8ea33038d18841af598adbac059b))

### Chores

- Bump version to 4.7.0 + update changelog ([`9a69249`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9a692490e5b18813b6bdc6bce90c949000be9262))
- Bump version to 4.6.1 [deploy] ([`9d8c186`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9d8c1862b0e4423add2b84307fef29c1a26f067b))
- **brand**: Complete cortex-telegram-hub-bot → nexus-hub rename across all files ([`29f996a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/29f996afa2224e1e3ab69f87c1c0afcd300d0856))
- Bump version to 4.6.0 ([`063c8fb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/063c8fb749392a847e226c38af3c0a8d671c528e))

### Features

- **safety**: AI call timeouts, per-user rate limiting enforcement, cost guardrails ([`9e0119f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9e0119fdc8a65f8adfaac191147f5700937173fe))
- **admin**: Per-user skill management — enable/disable skills and sub-skills from portal ([`27f2527`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/27f252708ce2eaf02d38383978d6d0766cdde91f))
- **multi-user**: Per-user OAuth token storage for Google + Outlook integrations ([`3c651a8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3c651a83bfbe320c4a0c2cab4fc1937b62def13d))
- **multi-user**: User registration, invite codes, bilingual onboarding, owner mode ([`7865863`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7865863230742057c5035ade15bb46f41c7dca1b))
- **multi-user**: Per-user data isolation — add userId to all state tables and queries ([`6470ed2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6470ed26191b8ebdbe015538d591d61b095b5aa6))
- **config**: SQLite-backed ConfigProvider with portal settings UI + multi-tenant ready ([`307e99b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/307e99b185b404a86bd086cb1b1c333539764a3b))
- **backup**: SQLite backup API, integrity checks, AES-256 encryption, weekly restore test ([`1ac9fe4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1ac9fe4e908d9e973d58f51249b83dad41e0c314))
- **providers**: Per-domain model overrides — granular cost optimization via portal ([`9d81869`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9d818691e753946ee4f26d333cfa559942f00528))
- **providers**: Circuit breaker metrics + hot-swappable model config via portal ([`d7c4a30`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d7c4a305c8c1a1480452b9a13a56c6b31398eb26))
- **storage**: SQLite KV store — get/set/delete/list/has/clear with JSON serialization and transactions ([`7c5e1f2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7c5e1f25974026833750a70df9dc2ea3d72c6533))

### Refactor

- **bot**: Split 4400-line bot.ts into modular command/middleware architecture ([`49b8f2e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/49b8f2e1a574b6cecf3fdc630129c042ce7f6a6e))

## [4.6.0] — 2026-04-03

### Bug Fixes

- **security**: Address all code review findings — webhook HMAC, cost pricing, temp files, retry ([`3876ab0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3876ab0d330af977e4cc33b2d83d19129af99b25))
- **agents**: QA agents now check Notion QA Validating column as fallback ([`a90635d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a90635d2653982c069ceb58d66751d11dc222ad0))
- **agents**: QA agents now auto-chain from .qa-queue after completing validation ([`1cc8d57`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1cc8d57ad26923feb362e4466329c4a71ee3a063))
- **agents**: QA queue only valid for QA Validating tasks — remove all others ([`c949b53`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c949b535c85003198c22b2f776137fdc96906b32))
- **agents**: AgentPath not defined in agent-complete.js — agents were crashing after task completion ([`8535e80`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8535e80fd82463670fae0bd1acbd3ec4c1676bb0))
- Restore execute permission on launch-agent.sh ([`86f8fef`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/86f8fef34f7e8a2343353c900ce177eec11fdd78))
- **agents**: Prevent QA duplicate tasks + clear stale active tasks + agent memory ([`c1753f0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c1753f01b17da079f07f3aba4ec022d022bcd934))
- **agents**: ALL tasks go through QA, fix missing agent field in dispatch ([`24620c6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/24620c69f998b4c2bb7192aae5399693b280b1b0))
- **agents**: Remove fallback dispatch, enforce strict agent routing ([`dd9ccdb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dd9ccdb50bd5eb9e01477d80e0c10cb637c3b151))
- Resolve merge — remove duplicate financeEncryption, fix tests ([`4763421`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4763421501b3e4cb66d3844e15ce30619838dbaa))
- **agents**: Fix allTasks scope — fetch once for Steps 1.5 + 1.6 ([`9eebd36`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9eebd36eed7e2cc6a3522d719f5fc7d9d6985165))
- **agents**: Add orphan recovery — re-queue QA Validating tasks with no queue file ([`82f537a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/82f537ab0a416887a13f3f82f62937c3a8ee7029))
- **agents**: Quote pwd in CLAUDE.md, fix placeholder bug, resolve type errors ([`a33f445`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a33f44505c2348b5c9f78d6af74ec5fe2bae25aa))

### Chores

- Bump version to 4.5.2 [deploy] ([`83fea13`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/83fea1380baa064b2eed1c7295549f6af00b2f2a))
- Bump version to 4.5.1 [deploy] ([`f3273b2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f3273b2111905d5581015b1af403728738a158c9))

### Documentation

- Add Software Factory implementation plan + board utility scripts ([`1173474`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1173474dfe9502eeb254ed379614657544956b49))
- Update changelog [skip ci] ([`339e0f6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/339e0f6c739ecd7d2f2233966269946f6b4769b2))
- Update changelog for v4.5.0 ([`eba2e31`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/eba2e31dd5dd0732286b8704fddb4166d957b7a5))

### Features

- **providers**: Circuit breaker metrics — usage/failure/fallback counts exposed via /health/detailed ([`87ad778`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/87ad7789e43ff6f63e859e89a97f2a462e3183db))
- **providers**: Gemini provider — token tracking, error handling, circuit breaker mapping ([`4fe662a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4fe662ab30ec011c684ef916ea9b3edc5a3adb04))
- **providers**: OpenAI provider — token tracking, streaming, error handling ([`b24b614`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b24b6143e747b715253b388c484b8921e9d0dfb6))
- **adapters**: WhatsApp adapter — webhooks, templates, sendPhoto, sendVoice, media upload ([`8577ea3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8577ea31acc2099424e7481745e1e5de5cb94269))
- **adapters**: TelegramAdapter — rate limiting, message splitting, parse fallback, new methods ([`8595afb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8595afbee24c51d645da258bac47fdc4b06f6c4d))
- **quality**: Agent output quality scoring per task execution ([`a722fa4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a722fa4205bc640dda73c4576a8fbd6a7b647c78))
- **errors**: Structured error categorization with retry strategies ([`2df5531`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2df5531ca4803966ce547cae173d8dca6071a08b))
- **metrics**: Add per-task cost and duration tracking ([`aa3ad60`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/aa3ad60ac01d89db9e48eee40600d9b7ffc49a01))
- **dispatch**: Add blocked-by dependency check before task dispatch ([`78b7e79`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/78b7e7910f577c4b61d795f13c9a869211ffa32b))
- **hooks**: Shift QA left — enforce vitest + tsc on pre-commit ([`7f6dc4b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7f6dc4b2b35d56b1a8558fa568518022436b256d))
- **agents**: Add branch context, file hints, and max-turns to reduce token waste ([`b6e806a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b6e806af669b7d80e7efeda6e9c71a5dd5cb1900))
- **agents**: Add CODEBASE.md architecture map, agent-specific instructions, Opus for backend/flex ([`1e0fda5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1e0fda559515a422de8446106f7be1cb231f63c7))
- **infra**: Add health check endpoint + uptime monitoring ([`53109b3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/53109b3e0cbc3b4f66e7b35a7e626111f957aeca))
- **portal**: Add adapter status panel (Telegram active, WhatsApp planned) ([`0c58483`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0c584833cdcf2e97d0a3ee909696dd3ff9407068))
- **finance**: Add per-user data isolation + AES-256-GCM encryption for financial data ([`d2c559d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d2c559d3ff4c09dafa6c7789a3fd39864feeda63))
- **sdk**: Design @nexushub/skill-sdk package with builder API ([`438470f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/438470f23b36228a01e60081d1588e8ccbd854ba))
- **skills**: Implement /skill enable|disable + sub-module toggles ([`5513f49`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5513f49c95ee8a78cdca07a736c47326af89790e))

### Tests

- **integration**: Add scenario-specific E2E tests — calendar, finance, cooking, ambiguous, tool loop ([`7d1537f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7d1537f6de3e148316a25e24563121c2ddeb4b4a))

## [4.5.0] — 2026-04-02

### Bug Fixes

- **agents**: Queue cleanup runs every cycle, active task removed from queue count ([`49c3d9e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/49c3d9e085134e40e469f96e454925717db75717))
- **agents**: Validate QA queue against Notion before dispatch — remove Done/stale tasks ([`eced132`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/eced13283debece14a21ee8c7dc1f022a6521f31))
- **mc**: Fix JS syntax error in agent tab — mismatched quote in queue display ([`abc2055`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/abc2055c965bf388b3d3d0a8f5f20218cd132e0e))
- **mc**: Show QA2 queue count in UI, fix stale task check for both QA agents ([`9cefb6a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9cefb6aad7303b134fe8781fa5a18e213eae5d8c))
- **agents**: Auto-assign loop now checks QA queues and dispatches idle QA agents ([`a674514`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a67451492bf20863e65d5c6617e7bbf085d682bc))
- **skills**: Add credential encryption manager and security audit tests ([`ec4f71e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ec4f71ee78e2553be5ce647f74cd5588f740e3c9))
- **mc**: StartAll/stopAll include 6 agents, resolve bot.ts merge conflict ([`5d2fc35`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5d2fc357818718848985610ca5fcf5fbe20f6242))
- **bot**: Derive /skill valid domains dynamically from DEFAULT_SKILLS ([`61921ef`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/61921ef814a07e5bc42de332adeaaafc51d565b5))
- **test**: Update finance tax tool count assertion (3→4 after annual_summary added) ([`b2d1d77`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b2d1d776a228f610d8bb2f5b91a23e4f70094e2c))
- **db**: Renumber fitness training migration 021→023 to avoid collision ([`dda4b15`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dda4b15311186e96b1ffc6b3a41d337fdb78e983))
- **test**: Update migration numbering test to allow shared prefixes ([`5ebeaa4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5ebeaa4e21991328d212b25492d51aa94a1c5095))
- **notifications**: Remove idle spam, stop broken --check-only calls ([`7d25ba1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7d25ba1b19dbf4b109fd670fa69ac6bd1672ad23))

### Chores

- Bump version to 4.4.6 [deploy] ([`31ffc55`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/31ffc5532c4c5530d8db502bafe7d1121365bc8e))

### Documentation

- Update changelog [skip ci] ([`4d7f6f3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4d7f6f36a23ede1c901d1bb4310d0a6263528f51))
- Generate CHANGELOG.md with git-cliff (v1.0.0 → v4.4.5) ([`f0a085e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f0a085e63deec8a29ed2952eafd17d4b35e85ec7))

### Features

- **skills**: Implement /skills and /skill commands — list installed skills ([`c1df5fd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c1df5fdfb75f0df2269111c1e55c1ffc9ba4d552))
- **finance**: Add annual tax summary, receipt auto-logging, and amount parsing ([`356a88d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/356a88da9fdc178ddca39a2eb450d1115a330f97))
- **metering**: Add per-user per-day AI usage metering system ([`859b77c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/859b77cdd65f94f38a06df236f52d7e963f65ec3))
- **bot**: Add /skills and /skill commands for skill inspection ([`48496ee`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/48496eefedd3f2202cbb19f76d0e115206efa6d1))
- **portal**: Add /health endpoint for uptime monitoring ([`9f94001`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9f940019d4581d2e24f78c185d595672c9c026a1))
- **ux**: Telegram HTML message template design system ([`4450a60`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4450a607ef8f44d60f171ba1a5becc8e6acb51b8))
- **cooking**: Add Cooking Chef skill — recipes, meal planning, shopping lists ([`76edda5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/76edda5d90bdc9583dc83112b1997510716b1873))
- **onboarding**: Reusable multi-step questionnaire system with profiles ([`9c64ec8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9c64ec8d971320d09a40fbea5ac4cb517f31dc0b))
- **calendar**: Deduplicate events across Google + Outlook calendars ([`d1a5cd6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d1a5cd67cce6247db4cf2fb1606e2747f9ecf111))
- **agents**: Cross-agent learning v2 — shared context + content formulas ([`984cb04`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/984cb04a9e274a1e7adcdbfa7444d7705a16561c))
- **finance**: Add Finance Tracker skill with DARF/Carnê-Leão tax calculation ([`c0dae41`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c0dae41eb3aacf298e6413f6b7d5a4c370526aa3))
- **triathlon**: Add fitness training plans with calendar blockers + weekly auto-adjust ([`efa6e9a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/efa6e9af4687826f4fc8db40633b9957f3073bc4))
- **webhooks**: Add event-driven integration layer infrastructure ([`41a5d7b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/41a5d7b1f8c8d5a8acf8dfa1731986370cf93578))
- **portal**: Add skill module status section to Status Portal ([`dbf3e35`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dbf3e35db739d7da10a4c52704d478d9df984fbd))
- **monitoring**: Add self-hosted error monitoring with Telegram alerting ([`27631ac`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/27631acc49656d7e7e1b6343e0046d00634a40ed))
- **router**: Dynamic skill registration via extensible DomainName type ([`caf6525`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/caf6525924488a00262abbceda8d68e9656b92fa))
- **router**: Dynamic skill-based routing via SkillRegistry ([`4cb8827`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4cb8827885a820e8266cd3f1d74053833897c073))
- **metering**: Add usage metering system to track AI messages per tenant per day ([`bd60df8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bd60df8e5bfabc20e6a90b5c133d73328f6cb127))
- **portal**: Add skill management panel with enable/disable toggles ([`8f62fdd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8f62fddf551a50c4a8282e9af03541ed313fdca3))
- **config**: Add ConfigProvider abstraction for per-tenant config ([`48ac864`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/48ac8646ba227fe39a40b428c9f83360847f8cd6))
- **agents**: Add Frontend + QA2 agents with QA routing by origin ([`7399abe`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7399abe8892863faab5676c2f16f652c6929a0e5))
- **deploy**: Auto-generate CHANGELOG.md on merge develop → main via git-cliff ([`2bdd94e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2bdd94edb31f53303605ba75d9fcbd5b7b356329))

### Refactor

- **skills**: Migrate content creator domain to skill package with granular sub-skills ([`0ac665a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0ac665a0450feb71ed3b531f8a70437bd7dbd53d))
- **router**: Verify dynamic skill registration + add finance/cooking route tests ([`b01509f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b01509fdd9e3dfe0f168a75d143c2179d076dab2))
- **skills**: Migrate secretary domain to skill package with granular sub-skills ([`1ea1d27`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1ea1d2779fe4b2df6e8f153b195944ee290df5d6))

### Tests

- **qa**: Validate /skills command refactor — fix stale assertions, update QA tests ([`564a275`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/564a2751b2fb4e792fe971f79baa6ea60adafeac))
- **qa**: Validate content skill v2 refactor — 31 new tests, fix 5 stale assertions ([`b073071`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b0730716a968f7b023c0f1baef39a60694229682))
- **metering**: Add 26 QA validation tests for usage metering system ([`71051f9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/71051f9c762db583155eea9418dd438fce9b9b67))
- **skills**: Add 24 QA validation tests for /skills command ([`2e5a1d5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2e5a1d5a1474e95344ebd1c089c3cd3e50d878e2))
- **portal**: Add 15 QA validation tests for health check endpoint ([`a0f12c9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a0f12c9da66464631d7c3b24ab868b0ea11ba7dd))
- **cooking**: Add 50 QA validation tests for Cooking Chef feature ([`06e9552`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/06e95524bcfe55a2796b044d45674b2e9215f52c))
- **onboarding**: Add 43 QA validation tests for smart onboarding questionnaires ([`1750b82`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1750b822427dc073542a4ca2a3105b9c05ab2889))
- **calendar**: Add 18 QA validation tests for calendar event deduplication ([`2e75793`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2e757935410913b5baf185fc7cfd895bf52adf91))
- **agents**: Add 26 QA validation tests for cross-agent learning v2 ([`5c3ad28`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5c3ad28f8747a39a8d23a5e093ef0a252c42098a))
- **finance**: Add 37 QA validation tests for finance tracker + per-user data isolation ([`1c1d21c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1c1d21c824c62e3460ea9b90b2c773ed4cf48ebe))
- **webhooks**: Add 42 QA validation tests for webhook registry event-driven layer ([`d201bde`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d201bdee6b05f01461c0189f3c7054bad2f234c5))
- **migrations**: Add 21 QA validation tests for skill database migrations ([`abef3b1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/abef3b1d74756b6ec1527b662739be08830ad88f))
- **skills**: Add 21 QA validation tests for secretary skill package refactor ([`9ce9dbd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9ce9dbdf55a3f979bbcd1005374e96118e50801e))
- **portal**: Add 27 QA validation tests for skill management panel ([`62a7a5a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/62a7a5a2e7c9b62deafd32099b4aed0f44511ba7))
- **regression**: Add 233 skill extraction regression tests — Sprint 2 merge gate ([`9af5387`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/9af5387b1545e7c21e45fbb561061244aceae025))
- **config-provider**: Add 25 QA validation tests for per-tenant config system ([`ffe002c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ffe002c9cf080639d6cd875e383480c27ed46ab3))

## [4.4.5] — 2026-04-01

### Bug Fixes

- **brand**: Rename Cortex IDEAS → Nexus Hub IDEAS in google-drive.ts ([`feda4b2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/feda4b27d4200e5111fed880ebf23b406c45b7c2))
- **brand**: Rename package.json nexus-hub → @nexushub/core ([`329d639`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/329d639298ba6118a2b69eb6635c69f5743a727b))
- **agents**: Verify code commits before chaining to QA, auto-push unpushed work ([`aac954d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/aac954d5a33d1b0f7da089073eec97678532bc8f))
- **agents**: Auto-launch on every cycle, fix path escaping, clearer status labels ([`0d59c55`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0d59c55298dc5e6012ff4378b9686f22d22e0b95))
- **agents**: Auto-assign validates stale tasks against Notion, recovers orphaned In Progress tasks ([`da0768a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/da0768a6198e4cb27062cfebd392e44719c06337))
- **ci**: Changelog workflow creates PR instead of pushing to protected main ([`0822557`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/08225571a145d8e0fedb32a5f92d536072cf4508))
- **git**: Correct merge-develop flow, add agent/backend branch, run tests before push ([`293a8bf`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/293a8bfe1b7632d35cf19a78cb8a9c43476cdee6))
- **voice-evolution**: Use correct column name full_text in transcript query ([`de28f2e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/de28f2e96e935971acbf4d86230c2d238d82e759))
- **mission-control**: Stop-all kills by PID, add dispatch task UI panel ([`619619c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/619619c5af97df4f188aa0794a2b138cf3f97a63))
- Remove stale QA validation tests from agent branches, 831 tests pass ([`db80812`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/db80812176849dc04240d077d09b717e84df0c51))

### CI/CD

- **portal**: Add integration health panel with OAuth token status ([`ebe90fe`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ebe90fef642f85e72dce984b01a866e39d74b563))
- **backup**: Add automated daily database backup with 30-day rotation ([`faf63b5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/faf63b5589261054e4a46a3bf3084cfe181b10fb))
- **brand**: Update domain references from nexushub.ai to nexushub.me ([`593f6d3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/593f6d3392a12ffe672bd63e19591b054efedb92))
- Add dispatch-task.js for manual agent bootstrapping ([`ac99b64`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ac99b648901afd4f99f9117db0a35a562b55170a))
- Add git-cliff auto-changelog on push to main ([`ff98ecf`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ff98ecfa1ed2418229c1f879498de07b0496c35a))

### Chores

- **legal**: Add MIT copyright headers to all 80 src/ files ([`33c8276`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/33c8276fd099791ef2ccd3167bdcb2234c0eb080))
- Bump version to 4.4.4 [deploy] ([`5e22696`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5e22696d549f2624ea250b5bd3ed541d4caafe0f))
- Bump version to 4.4.3 [deploy] ([`3d558df`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3d558dfc600c366b9c5124ed5256f13796103583))

### Documentation

- **agents**: Portal update is now mandatory for all user-facing features ([`0aa11e6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0aa11e66b65e6ff91f91264364cb13e19a46fe24))

### Features

- **skills**: Granular sub-skill architecture — domains become skills with toggleable sub-skills ([`52a9c5b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/52a9c5b3b77a250bc8b3a10d7752176cb1c826eb))
- **portal**: Add domain handler status section (pre-skill modules) ([`b0559b5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b0559b52f7747dfa90c50397a78819ff2214f623))
- **agents**: Server-side auto-assign loop (45s) + auto-launch offline agents + UI auto-refresh (30s) ([`1064c41`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1064c416d5a06af9a206b34c969faf0a963436f6))
- **agents**: Auto-orchestration, Telegram notifications, simplified Mission Control ([`5c2a325`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5c2a32588908e324dcb40cd1a8e26fbe91c65a87))

### Tests

- **skills**: Add 47 QA validation tests for granular sub-skill architecture ([`6df8472`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6df84720f140a7115def55edac0e7a6feba086c9))
- **portal**: Add 39 QA validation tests for domain handler status panel ([`564c608`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/564c6081d85ade01691375348a86c6c2e39a479a))
- **portal**: Add 43 QA validation tests for integration health panel ([`c234aec`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c234aec7da267686e1479c8a26ebff9977eac6dc))
- **brand**: Add 6 QA validation tests for MIT copyright headers ([`a5deef2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a5deef211dd7009050ac81e93890839296d3d7ba))
- **brand**: Add 11 QA validation tests for @nexushub/core rename ([`ede9604`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ede96045d8c6a5010f5e3286e8985095d6f1c904))
- **integration**: Add 44 message flow integration tests ([`10c1357`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/10c13575c67fc9728d58109fe9a07c6e1b5425e2))
- **agents**: Add 19 QA validation tests for Voice Evolution transcript column bug ([`6512f6a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6512f6a626be2bb4a49df93b4d7971030868295f))
- **skills**: Add 40 QA validation tests for SkillRegistry + SkillLoader ([`7fc7ac7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7fc7ac720a0a0a118eceb34d3b95fd73110cc091))

## [4.0.0] — 2026-03-31

### Bug Fixes

- **skills**: Align types and registry with QA branch conventions ([`f5da4fa`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f5da4fa3e173f9fdffbd33f39db6e665b8b773e6))
- **ops**: QA fail handler writes .agent-task.json alongside fix prompt ([`195576c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/195576c790be6827c7e174aef652706292ba033c))
- **ops**: Dispatch reads .env.agents, terminal button uses tty detection ([`ab8d89a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ab8d89a71514e98925ed441ac6fa9cce541ff5b8))
- **ops**: Ensure NOTION_TOKEN available to all agents via symlinks + env export + multi-path fallback ([`c58f921`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c58f92132f8b6a8eae5730bdb318cb3347eb0afc))
- **db**: Rename duplicate 019 migration to 020 ([`3607acc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3607accc006d26256cfe6836c63ab0e6cdb9d54c))
- Remove ghost account felipedrfwow, hardcode author ([`2b97351`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2b97351f0d48e605635c69638f98d0cd91eeb2b0))
- DST watchdog hardening, calendar date shifting & follow-up context (v4.4.2) (#5) ([`2acb8e9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2acb8e981ee5719cdc23dbd4f94608b49deeb047))
- Graceful shutdown awaits portal server close to prevent EADDRINUSE ([`8965738`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/896573876a21a7c44ab34b758d73fd70067e2e82))
- DST watchdog hardening, calendar date shifting & follow-up context (v4.4.2) ([`107cb69`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/107cb6960cd960e82b1f3dfd3e34d4446d7395a3))
- **deploy**: Rebuild native modules for PM2's Node version ([`f5568b3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f5568b36821f09861745c6c4a5535514bd0d0526))
- **deploy**: Increase health check wait to 10s with retry ([`118f15b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/118f15b61bb488e606fd98928f7401d94b00db49))
- Add Notion release logging to deploy.sh, fix secrets check in workflows ([`f9240b1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f9240b1c7e5959a05a6d4ed8565548a58f5fd2f2))
- **ci**: Lower coverage thresholds to match current main state ([`82fe363`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/82fe3634e299fabd84759cdd811210d64953f2f0))
- Address PR #4 review — raise coverage thresholds, env vars for server creds, add task dispatcher ([`d417dac`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d417dace6d91b85b800b9cd53455d0cbc0e3d4b7))
- Max_tokens overflow, JSON parsing & DST watchdog (v4.4.1) ([`6261307`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6261307ae373bbd18f51fd2b8034a2be424a0373))
- Portal Mission Control not rendering + add book form to portal ([`37494fa`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/37494fa16d26e1d34174053d6a8ea1a7ebb7a718))
- Security hardening + memory cleanup + DB indexes + invoice atomicity ([`96b0341`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/96b0341121e73e6342dfc86df76302a5b2d122b0))
- Context-aware message routing replaces heuristic-based continuity ([`8bcc6a2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8bcc6a27a55746806b477cd1207175a446313002))
- Resolve PM2 crash-loop (6742 restarts) + improve restart policies ([`526ea15`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/526ea15ec0d5fd221f9e822da908a0b362fa1461))
- Coach apply now updates/deletes existing events instead of creating duplicates ([`d72e7ef`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d72e7ef31e41a21aa689fcd784cc942e114024dc))
- Coach report formatting + triathlon apply-via-chat + deploy script ([`128f50e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/128f50e688c75f66c0ac0421a05ce7daff1f4779))

### CI/CD

- **skills**: Create SkillRegistry service ([`70d8ea5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/70d8ea5ddbb1dc36c2735f7de7ba7bf9cbbc6356))
- **db**: Add skill registry database migrations ([`fbbab87`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/fbbab87c156f84fd2637bb287978a30f35e13132))
- Add mandatory acceptance criteria for agent review handoff ([`2b39a2e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2b39a2e44c5195535d81f85f596441dfe0f568f1))
- **db**: Add skill registry database migrations ([`77c14ae`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/77c14aecbc18e30d1acada4ae24495dfee484208))
- Make CD manual-only, add DEPLOY.md, update CLAUDE.md with deploy rules ([`577883e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/577883ecfaf0ba7bc8e2540c4aa9b5ae7fc758f1))
- Make CD manual-only (server is IPv6, GitHub runners can't reach it) ([`24e5c40`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/24e5c409fb9c5a9daa8ce5b991978db4e591cd5b))
- Add bug agent role, hotfix workflow, updated CLAUDE.md ([`4de0551`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/4de0551d10a5ec68c393c885681380bd220919fc))
- Add server sync script for pulling production changes ([`0ff1b55`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0ff1b553d65a7b4fc5df28d9e245fe535b1aa554))
- Add multi-agent worktree setup, CLAUDE.md, and agent status scripts ([`03b8d4c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/03b8d4cce937395e7ff145943b6ea28985baf9b2))
- Lower coverage thresholds for initial test phase ([`255dc22`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/255dc221479f829616fe5ff9fd252f9b56140242))
- Add CI/CD pipeline, test framework, rollback system, branching strategy ([`914e88b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/914e88b7a01780968862358e8fcfe1fe8652d3ca))

### Chores

- Bump version to 4.4.2 [deploy] ([`29cd41f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/29cd41ffa000e82682c87dfa367ad51fb4e7523b))

### Documentation

- Update changelog version to 4.6.1 ([`80cec08`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/80cec08c7beb0343040c2aa53bc1f0b445887ba5))
- Update changelog with v4.1.1 portal enhancements ([`3da0f59`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3da0f59440421ab21b0668f37beb289e04454909))
- Update changelog with v4.0.0 bug fixes ([`ae2bbd9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ae2bbd95973649ee79ed90e48850237edefb437c))
- Update changelog with context-aware routing details ([`8055c92`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8055c924c4d8a021d5d435586c128189a90507f4))
- Update documentation to v3.7.0 + content workflow guide + creator profile ([`208438f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/208438fba64364c23de02d3e3348e096a1783c83))
- Add v3.5.0 changelog entry for Garmin MFA + multi-feature updates ([`3b1abe4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3b1abe464dd41bf1ae41445b130373e2f81fd6a3))

### Features

- **adapters**: Implement WhatsAppAdapter with Cloud API ([`7b9c89e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7b9c89e54e8acd3a0fcf1c9d1fde4a94f77191af))
- **adapters**: Implement TelegramAdapter with Grammy ([`11e5762`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/11e5762cae57e03eaa1228c6717b3d12f59f2f03))
- **providers**: Add per-task-type provider fallback with circuit breaker ([`1b1f815`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1b1f815ecbcd852129d60089a3b56b3bdbb85606))
- **skills**: Create SkillLoader service with manifest validation and dependency resolution ([`b134e5b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/b134e5b9c0315f9804c7c903ac011a4f85799e0c))
- **skills**: Define NexusSkill interface and manifest types ([`cc467f0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cc467f0d4b2ba2e390f8d57e1b88e06a59fb77cc))
- **storage**: Create StorageProvider interface with SQLiteStorage implementation ([`6fb34b5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6fb34b5d99ac4697c9c85226bba678d47ae9e84e))
- **skills**: Create SkillLoader service for dynamic skill packages ([`8ce4cd6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8ce4cd611f3ff5e6532620400ff4ec6b7fd8ca44))
- **bot**: Add /version command + auto-bump version on deploy ([`cd6e7f6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/cd6e7f6cb26b03ae951056d0bbd29047cd4bd2e3))
- **core**: Add OpenAI and Gemini AI providers (#7) ([`805c055`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/805c05533fcb04e664f8ef7fddce70ff546eb25c))
- **ops**: Autonomous agent mode - self-chaining pipeline with QA queue ([`57172d6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/57172d6b69b1da3a8513e22a83dbe0b7403c5739))
- **ops**: Add Mission Control portal, agent-complete self-chain, updated dispatch ([`3f9489a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3f9489a8af316bea7fbfe556a0bd670511533ca7))
- **core**: Add OpenAI and Gemini AI providers (#7) (#8) ([`8182818`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/818281882b4ced7d11e8ddf8bfa48c7c4af72679))
- **core**: Add AIProvider interface, AnthropicProvider, and full router tests ([`dedd8a1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dedd8a1fc1442306031fd6d77b90fd29073163f3))
- Content Accuracy Framework — anti-hallucination system (v4.4.0) ([`96b7963`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/96b79634ad75fe832f5d5381b160e93295dd9abe))
- The Operator unified brand + bug fixes + new commands (v4.3.0) ([`52ca4a2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/52ca4a25717f14ec4e0a6c1e77cf71fbdd452b60))
- Autoresearch system — automated prompt optimization (v4.2.0) ([`ff46c16`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ff46c16c89a945aacf57747ba46dc61299bb08f0))
- Agent mesh graph + domain-organized quick actions in portal ([`6d181f3`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6d181f36f9fa91585af0e32bd139aab5347aa1e6))
- Content Creation Consolidation Sprints 1-4 (v4.1.0) ([`8d44a13`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8d44a13fe11d70469ccf2f465642d2e4b8ea4514))
- Content Agent Mesh — 9 autonomous AI agents + intelligence bus + mission control (v4.0.0) ([`513ee0e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/513ee0e67113a6ed264759cd6466cd19e7d61146))
- Creator profile intelligence + Google Drive integration + deep search overhaul (v3.9.0) ([`d813e8f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d813e8ff6d35d78cac2920cfab8698be101161d0))
- Conversation continuity + secretary intelligence + content DOCX output (v3.8.0) ([`5548c7b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5548c7b514b1ded18f634b578d7aff6a4f5fa547))
- Content Creator Learning System + Garmin auth hardening + Telegram formatting (v3.7.0) ([`672fdeb`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/672fdeb552aec96be08d23a5dca4df3feafa8dae))
- Persist Garmin SSO cookies to avoid daily MFA emails ([`c79a962`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c79a962cdaa3ade943392b1030adbe2a8620dde6))
- Garmin MFA interactive login + rate-limit protection + multi-feature updates ([`6e55302`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6e55302bc9daf79b100c6904bd189b2439697333))
- Status Portal v3.3 + v3.4 — dashboard, email tracking, job history ([`259199d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/259199d8ec4e8c961b7e6dd2da78560cd6a292a5))
- Cortex Status Portal — self-hosted monitoring dashboard ([`a05dedc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/a05dedc79df54d34df58622e01cc716946ea7868))
- Garmin session keep-alive with 3-layer auth recovery ([`77509cc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/77509cc07f80a4c35e32d642295206fbe6332afa))
- Bi-weekly fossa séptica email automation ([`5027ac1`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5027ac1c25c4771dc0f17a595a87fe8a4650b2ae))

### Refactor

- **brand**: Rename Cortex → Nexus Hub across codebase ([`d61cc67`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d61cc675fba0df6102ce5af32ff3ce46c6694542))
- **dispatch**: Match Agent tags to role-based worktrees ([`7573a01`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7573a013239fb9a24370c346a47e40890952b6d6))

### Tests

- **brand**: Add 13 QA validation tests for Cortex → Nexus Hub rename ([`491e67b`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/491e67b777c90dac0948f3021f387e209d9f49ac))
- **services**: Add 36 QA validation tests for StorageProvider ([`d8206c0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d8206c00026ad1768d4bba6c315b2d22ac40acec))
- **skills**: Add 54 QA validation tests for skill database migrations ([`010adce`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/010adce9c46c199785e37fbe7a911e5ff69dd4f1))
- **adapters**: Add 78 QA validation tests for WhatsAppAdapter + fix loader tests ([`1d15224`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1d152248ddd89c0d73bbaae9c74621ee0daf57df))
- **adapters**: Add 47 QA validation tests for TelegramAdapter and MessageAdapter ([`642c607`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/642c607f92781be18e724ef45196af627e39e770))
- **ai-provider**: Add 38 QA validation tests for FallbackProvider and model routing ([`7e93b6f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7e93b6f03f23ce2b0faa37f471ca0c18e1970c3c))
- **skills**: Add 54 QA validation tests for SkillLoader service ([`dfc3675`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dfc3675002c0ab5bc0d08683c1c1a6ba3336d3d1))
- **skills**: Add 46 QA validation tests for NexusSkill and SkillManifest types ([`482cb36`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/482cb36584755d3ae4e3f59c6e5c91ec726c8c88))
- **skills**: Add SkillRegistry and SkillLoader tests ([`8c27b9c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8c27b9c6a35c26f48d17ac4d1ce8f1d21189cf0e))
- **domains**: Add 35 tests for domain handlers, secretary, and thin wrappers (#6) ([`dce0155`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/dce01557752d356d9bf964ca485e5a6ecad1b910))
- **skills**: Add SkillRegistry and SkillLoader tests ([`642dadd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/642dadddf7c51b8f0bc9eaebf5ea8d611b306947))
- **domains**: Add 35 tests for domain handlers, secretary, and thin wrappers (#6) ([`ba6cc51`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ba6cc516cbd1ff10b61eccd641b8a5a45026f575))
- **tool-executor**: Add 70 tests covering all 20+ tool dispatch cases ([`8461740`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8461740cc835f479afeb3cd365ec7b7196f2c8c0))

## [3.0.0] — 2026-03-11

### Bug Fixes

- Invoice filing guards, dead code removal, path fix, migration comment ([`6592904`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/65929041a0dd8466b7bd41857f4cc1924563473c))
- 7 code review fixes — rate limiter, pruning, parse_mode, router, auth, config, require ([`268e1c2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/268e1c238184102333b42c4109880fdb31672e08))
- **scheduler**: 5 bug fixes from code review — parse_mode, splitMessage, escapeHtml, nullish coalescing ([`20b3e3d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/20b3e3d00029bc23c223593014ed1b79a53198a2))
- **bot**: Resolve 15 bugs from codebase scan + add Cofidis vendor ([`18ed648`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/18ed64800844623f5e19920746e7c2d8bc6ce109))
- Resolve calendar category names from Outlook master categories ([`f3ce7a5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f3ce7a58e496399a4bb166a075a0888bcea9b0d2))
- Default to Red Category when no SMS/EC in calendar caption ([`3c6be8d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3c6be8d3a979bba891777a8b8af6a29bff86eec3))
- Handle truncated calendar JSON from max_tokens cutoff ([`eaa9c00`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/eaa9c00fe5d06a86e66438b11eae6d04403f7d35))

### Features

- Content Creation Engine (Phases 1-5) — 16 new commands + model upgrades ([`1f11cdd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1f11cdd6d8e100f803a70a62c5e1ce0bc839e404))
- **garmin-coach**: Interactive calendar recommendations + payload truncation fix ([`0083e06`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0083e0654f2c8016d57e37f7da0f19971e246856))
- **garmin**: Add Garmin Daily Coach briefing with /coach command ([`d274868`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d27486814cf821f84afe556adb66199f3d8dd661))
- Calendar event prefix, conflict detection, and confirmation flow ([`d935ee5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d935ee5ef6bce2ff935379edc2cb5bc1f8388019))

## [2.0.0] — 2026-03-08

### Bug Fixes

- Resolve 3 bugs in invoice collection for personal Outlook accounts ([`0b89361`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0b893614dc3ae5a96c4df7794223c206f4391f41))
- Add SSH port config and fix SCP quoting for reverse tunnel ([`bc579e7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bc579e729dabb638c8520f253a8eb146b85e6984))
- Replace 15-min task alerts with end-of-day summary (#3) ([`d1ed2c6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d1ed2c670f18c2e99834ea72a3f80ce0770511cf))

### Chores

- Remove Qlik Sense and AWS domains (#2) ([`beab009`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/beab0092b6bba608510de9dae414dd410e02d5fc))

### Documentation

- Update changelog with v1.6.0 through v1.8.0 entries ([`f2f4f8f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f2f4f8f4706824995269b8d82bc29f6a52c2632a))
- Update changelog with v1.3.0 and v1.4.0 entries ([`e68d760`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e68d76020ffe0b1f57028981fd126f86bc92a244))

### Features

- Unified image classifier (invoice/calendar/task) + security hardening ([`d8e6d9f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d8e6d9fab84c6f106bdb084951af8898d9be81e1))
- Add Amazon.es invoice collection via Playwright browser automation ([`e2dfb8d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e2dfb8dbc007b3df8e35bb4c72581f335b05e914))
- Add automated monthly invoice collection + image compression ([`d7d204d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d7d204dc0046136d8621d51ab73e2a006dcd0905))
- Add invoice/receipt photo filing to iCloud via SSH/SCP ([`c5169f2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c5169f2d063d98c4c7f6f0d22bdd253941c3dc4f))
- Add 12 feature improvements across bot capabilities ([`2bcd45c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2bcd45c71ea66da9aba37adbcbb6ca45a9246b65))
- Add daily content discovery with Claude web search (#1) ([`8565f8a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8565f8ae036a90842393c262aaf2be1446904564))

### Performance

- Optimize API costs and performance across 20 improvements ([`3189ff8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3189ff8979b17883644b709ddb5e817683bed35d))

### Refactor

- Replace SSH/SCP invoice filing with local filesystem writes ([`ca0664e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ca0664eba1188dd7be72f70a408c654532190fcc))

### Reverts

- Restore SSH/SCP invoice filing after iCloud FUSE failure ([`6ca7ec0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6ca7ec098cb38cef5548df2d192f8105564d8372))

## [1.0.0] — 2026-03-06

### Features

- Initial release v1.0.0 — Cortex Telegram Hub Bot ([`83b1363`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/83b1363f26bfec6f28c8a08aa173cded57179c92))


