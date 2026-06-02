# Source Notes for Agents

These are the main sources used to create this pack. Coding agents should use these as background references, not as a replacement for inspecting the actual Nexus Hub product and codebase.

## SaaS UI/UX and conversion

### Nielsen Norman Group: Homepage Design Principles
URL: https://www.nngroup.com/articles/homepage-design-principles/
Key idea: A homepage needs a clear value proposition that explains why a visitor should choose this company/product over alternatives.

### Nielsen Norman Group: Visual Hierarchy in UX
URL: https://www.nngroup.com/articles/visual-hierarchy-ux-definition/
Key idea: Visual hierarchy guides the user’s attention through color, contrast, scale, grouping, and layout.

### CXL: How to Build a High-Converting Landing Page
URL: https://cxl.com/blog/how-to-build-a-high-converting-landing-page/
Key idea: Landing pages need clarity, relevance, one most-wanted action, concise copy, and a proven structure.

### Baymard: Checkout UX Best Practices 2025
URL: https://baymard.com/blog/current-state-of-checkout-ux
Key idea: Checkout and purchase flows often lose conversions because of friction. For SaaS, apply this to signup, demo booking, payment, pricing, and onboarding flows.

## Accessibility

### W3C WCAG 2.2
URL: https://www.w3.org/TR/WCAG22/
Key idea: WCAG 2.2 adds important criteria around focus, target size, redundant entry, consistent help, and accessible authentication.

## Fonts and performance

### web.dev: Best Practices for Fonts
URL: https://web.dev/articles/font-best-practices
Key idea: Font loading, delivery, and rendering affect performance and user perception.

### web.dev: Optimize Web Fonts
URL: https://web.dev/learn/performance/optimize-web-fonts
Key idea: Web fonts can affect First Contentful Paint and layout/rendering behavior.

### Next.js: Font Optimization
URL: https://nextjs.org/docs/app/getting-started/fonts
Key idea: `next/font` can self-host Google Fonts, avoid external browser requests to Google, and optimize font loading.

### Google Fonts: Geist
URL: https://fonts.google.com/specimen/Geist
Recommended role: Primary Nexus Hub font.

### Google Fonts: Geist Mono
URL: https://fonts.google.com/specimen/Geist+Mono
Recommended role: Technical accents, metrics, dashboard labels.

### Google Fonts: Inter
URL: https://fonts.google.com/specimen/Inter
Recommended role: Body/UI if using a more distinctive display font.

### Google Fonts: Space Grotesk
URL: https://fonts.google.com/specimen/Space+Grotesk
Recommended role: Alternative display heading font.

## Agent setup

### OpenAI Codex: AGENTS.md
URL: https://developers.openai.com/codex/guides/agents-md
Key idea: Codex reads AGENTS.md before work, so it is the right place for repo instructions.

### OpenAI Codex: Agent Skills
URL: https://developers.openai.com/codex/skills
Key idea: Skills package reusable task-specific instructions and optional resources/scripts.

### Anthropic Claude Code: Memory / CLAUDE.md
URL: https://code.claude.com/docs/en/memory
Key idea: Claude Code reads CLAUDE.md for persistent project instructions and can import AGENTS.md.

### Anthropic Claude Code: Skills
URL: https://code.claude.com/docs/en/skills
Key idea: Project skills live under `.claude/skills/<skill-name>/SKILL.md`.

### Anthropic Claude Code: Subagents
URL: https://code.claude.com/docs/en/subagents
Key idea: Project subagents live under `.claude/agents/` and can specialize in UX, copywriting, or review tasks.
