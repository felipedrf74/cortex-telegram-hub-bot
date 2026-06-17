# ADR-0006: Serif editorial register for the Content Studio + domain-identity policy (last native font-design slot)

Status: accepted
Decision date: 2026-06-10
Decided by: workspace lead (Felipe) + Claude (multi-agent brainstorm + adversarial review, 2026-06-10)
Last verified: 2026-06-10

## Context

The app already practices font-design-as-wayfinding without naming it:
SF Rounded marks brand moments (onboarding welcome, the 30pt hero card), SF
Mono marks machine data, and SF italic marks generated voice
(`ScriptGeneratorView.swift` hooks/CTAs). The Content Studio needed a visual
identity that distinguishes creative space from the utilitarian app shell —
and SwiftUI offers exactly four native font designs. Assigning the last one
(.serif / New York) is a one-way door, and other skills will request
identities once Content has one.

## Decision

1. **New York serif (native `Font.system(style, design: .serif)`, zero
   dependencies) becomes the Content Studio's editorial register**, exposed
   ONLY through four semantic tokens in `Font+Nexus.swift` behind a
   `NexusSerif` factory: `nexusSerifTitle` (zone mastheads, max one per
   screen), `nexusSerifTitle2` (detail-screen titles only — **cards never
   serif**), `nexusSerifHeadline` (hero headline), `nexusSerifQuote`
   (**earned register**: machine drafts keep italic-sans; serif roman renders
   only user-kept/edited lines and user-applied learnings).
2. **Floors**: no serif below `.callout`/16pt or below `.medium` weight (New
   York hairlines ≈1px at 14pt on `#0A0A0A` OLED — halation). Masthead
   collapse is an opacity/position crossfade between two pre-laid sizes
   (28pt/20pt class), never continuous glyph scaling. Bold Text is gated in
   the factory. Enforcement: `scripts/ios-serif-usage-check.sh` grep guard +
   source-pin contract test (no SwiftLint in repo; no new dependencies).
3. **Domain-identity policy**: a domain may carry a typographic identity only
   if the type design is the native register of the domain's OUTPUT MEDIUM,
   not its mood (material-honesty test). Content's artifact is published text
   → serif passes. The four native designs are the ceiling: default = app
   voice, rounded = brand warmth, mono = machine data, serif = published word.
   All slots are now assigned; the default answer to new identity requests is
   **no**.

## Alternatives considered

- **Custom font (Font.custom / UIAppFonts).** Rejected: violates the repo's
  zero-dependency stance, loses free Dynamic Type/Bold Text support, and
  breaks the natural four-slot ceiling that prevents identity sprawl.
- **Serif on cards and small chips (original mockups had 14–16pt serif card
  titles).** Rejected by legibility floor + adversarial review: below-floor
  hairlines shimmer on OLED dark, and a "featured-tier" card boundary is
  unenforceable; "cards never serif" is binary and grep-able.
- **Serif for all generated quotes.** Rejected: dressing raw model output in
  the register of the published word lends it unearned authority — the same
  ceremony-exceeds-intelligence failure the hero design forbids. Hence the
  earned two-state register.
- **No identity (sans everywhere).** Rejected: the studio's wayfinding value
  (serif = you are in creative space, a place cue) extends an existing
  in-app convention at near-zero cost; predeclared kill criterion exists.

## Consequences

- **Positive**: distinctive, implementable identity (one token block); the
  register system becomes explicit and closed; typography joins the
  substantiation ethos (serif earned by acceptance).
- **Negative**: brand-land (marketing site: Inter-900 + JetBrains Mono) has
  no serif — accepted as a different speaker (marketing types about the app;
  the studio types about the user's work); a `--font-serif` token should be
  pre-staged in `nexushub-landing-astro` before public launch.
- **Operational / kill criterion**: if PT-BR 5-second tests read serif
  screens as "premium/chique/paywall-like" rather than creative-space, the
  identity is being parsed as upsell decoration and is removed (tokens make
  rollback mechanical).

## Links

- Related code paths: `Nexus Hub/Extensions/Font+Nexus.swift`,
  `scripts/ios-serif-usage-check.sh`,
  `Views/Content/Studio/ContentStudioMasthead.swift`
- Decision trail: Claude project memory `content-studio-redesign-proposal.md`
- Related ADRs: ADR-0005 (Content Studio architecture)
