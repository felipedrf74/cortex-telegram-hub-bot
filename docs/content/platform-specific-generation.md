# Platform-Specific Generation

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Supported Format Contracts

The generation-quality layer uses the Content ontology format registry:

- YouTube long-form
- YouTube Shorts
- Instagram Reels
- TikTok
- LinkedIn post
- X/Twitter thread
- Newsletter
- Blog
- Podcast outline
- Carousel
- Generic script
- Caption

## Why This Matters

Content should not be a generic script reshaped with a platform label. Format rules affect:

- structure
- length
- hook style
- pacing
- source usage
- production requirements
- review needs
- output fields

## Examples Of Format Differences

YouTube long-form:

- cold open
- context
- stakes
- teaching beats
- proof
- payoff
- CTA

LinkedIn post:

- scroll-stop line
- context
- insight
- specific example
- discussion prompt

Short-form video:

- first-second hook
- one-point short script
- visual beats
- caption
- CTA

Thread:

- thread hook
- posts
- receipts
- closing prompt

## Tests

Focused tests verify:

- YouTube and LinkedIn contracts differ.
- Short-form contracts carry hook/visual/pacing expectations.
- Platform adaptation plans target the new format rather than compressing the old output blindly.

## Open Work

- Add app-facing generation routes beyond existing YouTube/Reel script route.
- Add iOS/portal DTO/rendering for additional format contracts.
- Run representative provider-backed quality evaluations.
