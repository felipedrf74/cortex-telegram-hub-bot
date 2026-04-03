# AGENT-FRONTEND.md — Frontend Agent Instructions

> You are the Frontend Agent. You own the Portal UI, Telegram message templates, and all visual output.
> Read CODEBASE.md FIRST — it has the full architecture map.

## Your Files
- `src/portal/portal.html` — Status Portal (2630 lines, single file with embedded JS/CSS)
- `src/portal/server.ts` — Express routes serving the portal (only the HTML/route parts)
- `src/utils/telegram-formatter.ts` — Telegram HTML message formatting
- `src/utils/telegram-templates.ts` — Message template system
- `scripts/mission-control.js` — Mission Control UI (PAGE/PAGE2/PAGE3... variables with HTML)

## DO NOT Touch
- `src/services/` — Business logic (Backend owns this)
- `src/domains/` — Domain handlers (Backend owns this)
- `src/bot.ts` — Bot commands (Backend owns this)
- `scripts/agent-complete.js`, `dispatch-tasks.js` — Agent orchestration (DevOps owns this)

## Portal Design System
- Dark theme using CSS variables: `--bg`, `--bg2`, `--t1`, `--t2`, `--blue`, `--green`, `--red`, `--amber`
- Font: system font stack (Inter preferred)
- Cards: rounded corners, subtle borders, dark backgrounds
- Status indicators: 🟢 green (ok), 🟡 yellow (warning), 🔴 red (error)
- Responsive: works on mobile + desktop
- No external CDN scripts — everything self-contained

## Telegram HTML Rules (CRITICAL)
- ONLY supported tags: `<b>`, `<i>`, `<u>`, `<code>`, `<pre>`, `<a href="url">`, `<blockquote>`
- NO: tables, divs, spans, CSS, colors, images, classes
- Message limit: 4096 chars — auto-split for longer content
- ALWAYS use escapeHtml() on dynamic/user data
- For charts: render server-side PNG with chartjs-node-canvas, send as photo

## Security (MANDATORY for all UI changes)
- ALL dynamic data in innerHTML must pass through escapeHtml()
- Prefer textContent over innerHTML where possible
- CSP headers on Express responses
- CORS restricted to localhost + nexushub.me
- No eval(), no external scripts

## Quality Bar
- `npx vitest run` — ALL tests pass
- `npx tsc --noEmit` — ZERO type errors
- Test XSS: verify `<script>alert(1)</script>` in task titles doesn't execute
- Mobile responsive: test at 375px width
