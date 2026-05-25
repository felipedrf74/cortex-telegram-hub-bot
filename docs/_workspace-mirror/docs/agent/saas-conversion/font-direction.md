# Nexus Hub Font Direction

## Recommended direction
Use **Geist Sans** as the primary website and product UI font, plus **Geist Mono** for technical accents.

This gives Nexus Hub a modern, developer-friendly, precise, premium SaaS feel. It also avoids a common problem: using a decorative headline font that looks impressive but weakens readability.

## Primary font stack

### Geist Sans
Use for:
- Body text
- UI labels
- Buttons
- Navigation
- Hero headline
- Feature cards
- Pricing and FAQ

Why:
- Clean and modern.
- Strong fit for technical SaaS and developer-adjacent products.
- Works well as a single-family system, which reduces complexity.

### Geist Mono
Use for:
- Metrics
- Dashboard labels
- Code-like snippets
- Integration identifiers
- Tiny technical tags

Why:
- Adds a technical feel without making the whole site feel cold.
- Pairs naturally with Geist Sans.

## Alternative font stack

### Space Grotesk + Inter
Use **Space Grotesk** for H1/H2 display headings and **Inter** for body/UI.

Choose this if the current Nexus Hub brand feels too generic and needs a stronger visual signature.

Tradeoff:
- More distinctive than all-Geist.
- Slightly more complex to manage.
- Space Grotesk should not be overused for long body copy.

## Other good candidates

### Sora
Good for futuristic, geometric SaaS headings. Use carefully because it can feel too stylized if used everywhere.

### DM Sans
Good for friendlier, approachable SaaS products. Less “technical premium” than Geist.

### Manrope
Good for polished enterprise SaaS. Very readable and neutral.

## Type scale recommendation

Use CSS variables or Tailwind tokens based on this scale:

- Display/Hero: 48-72px desktop, 36-44px mobile, line-height 0.95-1.08
- H1: 44-60px desktop, 34-42px mobile
- H2: 32-44px desktop, 28-34px mobile
- H3: 22-28px
- Body large: 18-20px
- Body: 16-18px
- Small: 14px
- Label: 12-14px, slightly increased letter spacing only for short labels

## CSS token example

```css
:root {
  --font-sans: "Geist", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "Geist Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;

  --text-display: clamp(2.5rem, 6vw, 4.75rem);
  --text-h1: clamp(2.25rem, 5vw, 4rem);
  --text-h2: clamp(1.875rem, 3.5vw, 3rem);
  --text-h3: clamp(1.375rem, 2vw, 1.75rem);
  --text-body-lg: 1.125rem;
  --text-body: 1rem;
  --text-small: 0.875rem;
}
```

## Next.js implementation example

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

Apply to the root layout:

```tsx
<html lang="en" className={`${fontSans.variable} ${fontMono.variable}`}>
  <body>{children}</body>
</html>
```

## Typography rules for coding agents

- Do not use more than two primary families plus mono.
- Avoid loading every possible weight.
- Prefer 400, 500, 600, 700 unless a stronger reason exists.
- Keep paragraph line length comfortable, ideally around 60-80 characters.
- Use typography to clarify hierarchy, not just decorate.
- Use mono only as an accent.
- Validate mobile line breaks in hero headlines.

## Source URLs
- Google Fonts, Geist: https://fonts.google.com/specimen/Geist
- Google Fonts, Geist Mono: https://fonts.google.com/specimen/Geist+Mono
- Google Fonts, Inter: https://fonts.google.com/specimen/Inter
- Google Fonts, Space Grotesk: https://fonts.google.com/specimen/Space+Grotesk
- Google Fonts, Sora: https://fonts.google.com/specimen/Sora
- Google Fonts, DM Sans: https://fonts.google.com/specimen/DM+Sans
- Google Fonts, Manrope: https://fonts.google.com/specimen/Manrope
- Next.js Font Optimization: https://nextjs.org/docs/app/getting-started/fonts
- web.dev Font Best Practices: https://web.dev/articles/font-best-practices
