# Nexus Hub Website Agent Instructions

Use these instructions for Codex, Claude Code, and any coding agent improving the Nexus Hub website.

## Mission
Improve Nexus Hub as a high-converting SaaS website: clear value proposition, credible differentiation, strong visual hierarchy, low-friction signup/purchase flow, and polished modern UI.

## Product positioning direction
- Treat Nexus Hub as a modern SaaS/productivity hub unless product files prove otherwise.
- The website must quickly answer: who it is for, what problem it solves, why it is different, and what action the visitor should take next.
- Convert features into benefits. Do not list features without explaining the customer outcome.
- Prefer concrete, specific copy over generic SaaS phrases.

## Research-backed UX principles to apply
- Homepage: every visible element should reinforce a persuasive value proposition and answer “why choose this company over alternatives?”
- Visual hierarchy: guide attention with scale, contrast, grouping, spacing, and consistent layout rhythm.
- Landing page conversion: define one primary action per page/section, make the CTA obvious, remove distractions, and write copy before finalizing layout.
- Trust: add proof close to decision points: testimonials, integrations, security notes, customer logos, metrics, guarantees, or screenshots.
- Checkout/signup: reduce friction, avoid unnecessary fields, provide clear errors, and keep users oriented through the flow.
- Accessibility: target WCAG 2.2 AA. Include visible keyboard focus, accessible names, semantic headings, adequate contrast, and usable target sizes.
- Performance: avoid heavy visual effects that slow First Contentful Paint, Largest Contentful Paint, or interaction readiness.

## Recommended page structure
1. Hero: benefit-first headline, short support copy, primary CTA, secondary CTA, product UI visual, 1 proof signal.
2. Problem: show the pain Nexus Hub removes.
3. Solution overview: 3-5 core benefits in plain language.
4. Differentiators: what Nexus Hub does better than competitors or manual workflows.
5. Feature proof: screenshots, short demos, workflows, before/after examples.
6. Use cases/personas: map benefits to customer jobs-to-be-done.
7. Social proof: testimonials, logos, metrics, case snippets, review quotes.
8. Pricing or plan teaser: simple comparison, recommended plan, risk reducer.
9. FAQ: answer objections about setup, support, security, integrations, migration, cancellation.
10. Final CTA: repeat the most-wanted action with confidence-building microcopy.

## Copywriting rules
- Use this formula for every major section: Customer problem -> Nexus Hub capability -> measurable/customer benefit -> proof or example -> CTA.
- Replace vague claims with specific outcomes. Bad: “Powerful platform.” Better: “Manage client workflows, documents, and follow-ups from one hub.”
- Keep section intros short. Use scannable bullets and descriptive subheads.
- CTA text should say what happens next: “Start free trial”, “Book a demo”, “See Nexus Hub in action”. Avoid weak CTAs like “Learn more” unless secondary.
- Do not use lorem ipsum in finished UI.

## Visual design direction
- Brand personality: modern, technical, trustworthy, premium, efficient.
- Prefer clean layouts, strong spacing, clear hierarchy, and product-led visuals over decorative clutter.
- Use subtle gradients, glass/blur, or glow effects only when they support hierarchy and do not hurt readability/performance.
- Components should feel like a real SaaS product: cards, dashboards, workflows, integration badges, comparison tables, and proof modules.
- Use icons sparingly. Each icon must reinforce meaning, not decorate empty content.

## Typography direction
Primary recommendation: use Geist Sans for the main UI and marketing typography, with Geist Mono for technical labels, code-like snippets, metrics, or dashboard details.

Alternative if the site needs a stronger distinct marketing personality: use Space Grotesk for H1/H2 display headings and Inter for body/UI text.

Typography rules:
- Use no more than two families plus one mono family.
- Body copy should be 16-18px with comfortable line-height.
- Headlines should be short, benefit-driven, and visually dominant.
- Use a consistent type scale: display, h1, h2, h3, body, small, label.
- Never sacrifice legibility for style.

## Font implementation guidance
- If the project uses Next.js, prefer `next/font/google` for Google Fonts. It self-hosts fonts at build time and avoids browser requests to Google.
- Prefer variable fonts when available.
- Load only needed subsets and weights.
- Use `display: 'swap'` unless the framework default already handles it.
- Define fonts once in a central file or root layout, then expose CSS variables.
- Do not commit random font binaries unless license and source are confirmed.

Recommended Next.js pattern:

```ts
import { Geist, Geist_Mono } from 'next/font/google'

export const fontSans = Geist({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

export const fontMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
})
```

## Frontend implementation standards
- Inspect the current stack before editing.
- Preserve existing design tokens when good; improve them if inconsistent.
- Prefer reusable components: Hero, FeatureCard, BenefitGrid, ProofSection, PricingCard, FAQ, CTASection.
- Use semantic HTML: `header`, `main`, `section`, `nav`, `footer`, proper heading order.
- Keep components responsive from mobile-first to desktop.
- Add accessible labels to buttons, links, icons, inputs, and form errors.
- Avoid hidden interaction traps: modals, dropdowns, tabs, and carousels must be keyboard usable.
- Do not add new dependencies unless the benefit is clear.

## Conversion review checklist
Before considering work done, verify:
- The hero communicates value in under 5 seconds.
- There is one clear primary CTA above the fold.
- Features are reframed as customer outcomes.
- Differentiators are visible without forcing the visitor to read everything.
- Pricing/signup/demo steps are easy to understand.
- Trust signals appear near CTAs and pricing decisions.
- The page is responsive and readable on mobile.
- Keyboard focus is visible and logical.
- Images have useful alt text or are decorative with empty alt.
- Lighthouse or equivalent checks are acceptable for performance, accessibility, best practices, and SEO.

## Agent workflow
1. Read project files and identify the framework, routes, components, styling system, and content source.
2. Audit current UX and copy before making changes.
3. Make a short improvement plan focused on conversion, clarity, and maintainability.
4. Implement changes in small, reviewable steps.
5. Run available build, lint, type, and test commands.
6. Review the diff against this instruction file.
7. Summarize what changed, why it improves conversion, and what remains to test with real users.

## Do not do
- Do not redesign everything blindly if targeted improvements will work.
- Do not invent product features that are not supported by the codebase or provided content.
- Do not hide pricing, CTAs, or important objections behind vague copy.
- Do not use low-contrast text, tiny font sizes, or animation-heavy hero sections that reduce clarity.
- Do not treat accessibility as optional.
