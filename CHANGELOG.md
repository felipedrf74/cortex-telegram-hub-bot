# Changelog

All notable changes to Nexus Hub (formerly Cortex Telegram Hub Bot) are documented in this file.

---
## [Unreleased]

### Bug Fixes

- **ci**: Changelog workflow creates PR instead of pushing to protected main ([`0822557`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/08225571a145d8e0fedb32a5f92d536072cf4508))
- **git**: Correct merge-develop flow, add agent/backend branch, run tests before push ([`293a8bf`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/293a8bfe1b7632d35cf19a78cb8a9c43476cdee6))
- **voice-evolution**: Use correct column name full_text in transcript query ([`de28f2e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/de28f2e96e935971acbf4d86230c2d238d82e759))
- **mission-control**: Stop-all kills by PID, add dispatch task UI panel ([`619619c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/619619c5af97df4f188aa0794a2b138cf3f97a63))
- Remove stale QA validation tests from agent branches, 831 tests pass ([`db80812`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/db80812176849dc04240d077d09b717e84df0c51))
- **skills**: Align types and registry with QA branch conventions ([`f5da4fa`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f5da4fa3e173f9fdffbd33f39db6e665b8b773e6))
- **ops**: QA fail handler writes .agent-task.json alongside fix prompt ([`195576c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/195576c790be6827c7e174aef652706292ba033c))
- **ops**: Dispatch reads .env.agents, terminal button uses tty detection ([`ab8d89a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ab8d89a71514e98925ed441ac6fa9cce541ff5b8))
- **ops**: Ensure NOTION_TOKEN available to all agents via symlinks + env export + multi-path fallback ([`c58f921`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c58f92132f8b6a8eae5730bdb318cb3347eb0afc))
- **db**: Rename duplicate 019 migration to 020 ([`3607acc`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3607accc006d26256cfe6836c63ab0e6cdb9d54c))
- Remove ghost account felipedrfwow, hardcode author ([`2b97351`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2b97351f0d48e605635c69638f98d0cd91eeb2b0))
- DST watchdog hardening, calendar date shifting & follow-up context (v4.4.2) (#5) ([`2acb8e9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2acb8e981ee5719cdc23dbd4f94608b49deeb047))
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
- Invoice filing guards, dead code removal, path fix, migration comment ([`6592904`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/65929041a0dd8466b7bd41857f4cc1924563473c))
- 7 code review fixes — rate limiter, pruning, parse_mode, router, auth, config, require ([`268e1c2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/268e1c238184102333b42c4109880fdb31672e08))
- **scheduler**: 5 bug fixes from code review — parse_mode, splitMessage, escapeHtml, nullish coalescing ([`20b3e3d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/20b3e3d00029bc23c223593014ed1b79a53198a2))
- **bot**: Resolve 15 bugs from codebase scan + add Cofidis vendor ([`18ed648`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/18ed64800844623f5e19920746e7c2d8bc6ce109))
- Resolve calendar category names from Outlook master categories ([`f3ce7a5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f3ce7a58e496399a4bb166a075a0888bcea9b0d2))
- Default to Red Category when no SMS/EC in calendar caption ([`3c6be8d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3c6be8d3a979bba891777a8b8af6a29bff86eec3))
- Handle truncated calendar JSON from max_tokens cutoff ([`eaa9c00`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/eaa9c00fe5d06a86e66438b11eae6d04403f7d35))
- Resolve 3 bugs in invoice collection for personal Outlook accounts ([`0b89361`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0b893614dc3ae5a96c4df7794223c206f4391f41))
- Add SSH port config and fix SCP quoting for reverse tunnel ([`bc579e7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/bc579e729dabb638c8520f253a8eb146b85e6984))
- Replace 15-min task alerts with end-of-day summary (#3) ([`d1ed2c6`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d1ed2c670f18c2e99834ea72a3f80ce0770511cf))

### CI/CD

- Add dispatch-task.js for manual agent bootstrapping ([`ac99b64`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ac99b648901afd4f99f9117db0a35a562b55170a))
- Add git-cliff auto-changelog on push to main ([`ff98ecf`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ff98ecfa1ed2418229c1f879498de07b0496c35a))
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

- Bump version to 4.4.4 [deploy] ([`5e22696`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5e22696d549f2624ea250b5bd3ed541d4caafe0f))
- Bump version to 4.4.3 [deploy] ([`3d558df`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3d558dfc600c366b9c5124ed5256f13796103583))
- Bump version to 4.4.2 [deploy] ([`29cd41f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/29cd41ffa000e82682c87dfa367ad51fb4e7523b))
- Remove Qlik Sense and AWS domains (#2) ([`beab009`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/beab0092b6bba608510de9dae414dd410e02d5fc))

### Documentation

- Update changelog with v4.1.1 portal enhancements ([`3da0f59`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3da0f59440421ab21b0668f37beb289e04454909))
- Update changelog with v4.0.0 bug fixes ([`ae2bbd9`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ae2bbd95973649ee79ed90e48850237edefb437c))
- Update changelog with context-aware routing details ([`8055c92`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8055c924c4d8a021d5d435586c128189a90507f4))
- Update documentation to v3.7.0 + content workflow guide + creator profile ([`208438f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/208438fba64364c23de02d3e3348e096a1783c83))
- Add v3.5.0 changelog entry for Garmin MFA + multi-feature updates ([`3b1abe4`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3b1abe464dd41bf1ae41445b130373e2f81fd6a3))
- Update changelog with v1.6.0 through v1.8.0 entries ([`f2f4f8f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/f2f4f8f4706824995269b8d82bc29f6a52c2632a))
- Update changelog with v1.3.0 and v1.4.0 entries ([`e68d760`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e68d76020ffe0b1f57028981fd126f86bc92a244))

### Features

- **agents**: Auto-orchestration, Telegram notifications, simplified Mission Control ([`5c2a325`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/5c2a32588908e324dcb40cd1a8e26fbe91c65a87))
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
- Content Creation Engine (Phases 1-5) — 16 new commands + model upgrades ([`1f11cdd`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/1f11cdd6d8e100f803a70a62c5e1ce0bc839e404))
- **garmin-coach**: Interactive calendar recommendations + payload truncation fix ([`0083e06`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/0083e0654f2c8016d57e37f7da0f19971e246856))
- **garmin**: Add Garmin Daily Coach briefing with /coach command ([`d274868`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d27486814cf821f84afe556adb66199f3d8dd661))
- Calendar event prefix, conflict detection, and confirmation flow ([`d935ee5`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d935ee5ef6bce2ff935379edc2cb5bc1f8388019))
- Unified image classifier (invoice/calendar/task) + security hardening ([`d8e6d9f`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d8e6d9fab84c6f106bdb084951af8898d9be81e1))
- Add Amazon.es invoice collection via Playwright browser automation ([`e2dfb8d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/e2dfb8dbc007b3df8e35bb4c72581f335b05e914))
- Add automated monthly invoice collection + image compression ([`d7d204d`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d7d204dc0046136d8621d51ab73e2a006dcd0905))
- Add invoice/receipt photo filing to iCloud via SSH/SCP ([`c5169f2`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/c5169f2d063d98c4c7f6f0d22bdd253941c3dc4f))
- Add 12 feature improvements across bot capabilities ([`2bcd45c`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/2bcd45c71ea66da9aba37adbcbb6ca45a9246b65))
- Add daily content discovery with Claude web search (#1) ([`8565f8a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/8565f8ae036a90842393c262aaf2be1446904564))
- Initial release v1.0.0 — Cortex Telegram Hub Bot ([`83b1363`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/83b1363f26bfec6f28c8a08aa173cded57179c92))

### Performance

- Optimize API costs and performance across 20 improvements ([`3189ff8`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/3189ff8979b17883644b709ddb5e817683bed35d))

### Refactor

- **brand**: Rename Cortex → Nexus Hub across codebase ([`d61cc67`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/d61cc675fba0df6102ce5af32ff3ce46c6694542))
- **dispatch**: Match Agent tags to role-based worktrees ([`7573a01`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7573a013239fb9a24370c346a47e40890952b6d6))
- Replace SSH/SCP invoice filing with local filesystem writes ([`ca0664e`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/ca0664eba1188dd7be72f70a408c654532190fcc))

### Reverts

- Restore SSH/SCP invoice filing after iCloud FUSE failure ([`6ca7ec0`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6ca7ec098cb38cef5548df2d192f8105564d8372))

### Tests

- **agents**: Add 19 QA validation tests for Voice Evolution transcript column bug ([`6512f6a`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/6512f6a626be2bb4a49df93b4d7971030868295f))
- **skills**: Add 40 QA validation tests for SkillRegistry + SkillLoader ([`7fc7ac7`](https://github.com/felipedrf74/cortex-telegram-hub-bot/commit/7fc7ac720a0a0a118eceb34d3b95fd73110cc091))
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


