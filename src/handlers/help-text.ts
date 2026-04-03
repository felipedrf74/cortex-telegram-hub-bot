// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Help text constant — the /help command response.
 * Extracted from bot.ts to keep the composition root clean.
 */

export const HELP_TEXT = `<b>🤖 Nexus Hub Command Reference</b>

<b>📋 MICROSOFT TO DO</b>
/lists — Show all task lists
/tasks [list] — Tasks in a list
/alltasks — All tasks across all lists
/newtask [task] — Create task
/newtask [list] | [task] — Create in specific list
/done [task] — Complete a task
/undone [task] — Reopen a task
/edittask [task] | [new title] — Rename a task
/notetask [task] | [note] — Add description
/movetask [task] | [list] — Move to another list
/addstep [task] | [step] — Add checklist step
/steps [task] — Show checklist steps
/newlist [name] — Create a list
/deletelist [name] — Delete a list
/deletetask [task] — Delete a task
/due [task] | [date] — Set due date
/remind [task] | [time] — Set reminder
/priority [task] | [level] — Set importance
/search [query] — Search tasks
/todosummary — Task summary
/overdue — All overdue tasks
/duetoday — Tasks due today
/dueweek — Tasks due this week
/completed [list] — Recently completed tasks

<b>📅 SCHEDULE &amp; SECRETARY</b>
/day — Today's schedule
/week — Week overview
/plan — Tomorrow's plan
/review — Weekly review

<b>🏋️ TRIATHLON &amp; COACH</b>
/coach — Daily training analysis (Garmin data + calendar)
/checkin — How I feel today
/gym — Gym program
/run — Running plan
/bike — Cycling plan
/meal — Carnivore meal plan
/macros — Macros tracking
/deload — Deload recommendations
/pain — Pain/injury report

<b>📹 CONTENT — Quick Guide</b>
• Want ideas? → Wait for Tue/Thu/Fri auto-delivery or /contenttopic
• Research trends? → /discover (--news or --platform)
• Reaction angles? → /reaction [topic]
• Ready to write? → /script [topic]
• Have a script? → /repurpose to multiply
• Published? → /published [URL] to close pipeline
• Track performance? → /feedback [URL]

<b>🔍 DISCOVER &amp; RESEARCH</b>
/discover — Full content discovery (trending + ideas)
/discover --news — Hot news scan
/discover --platform — Cross-platform trends
/deepsearch [topic] — Deep research pipeline
/sources [topic] — Curated source list
/reaction [topic] — Find reaction-worthy content

<b>✍️ CREATE</b>
/script [topic] — Full video script (research + AI intelligence)
/hooks [topic] — Generate scroll-stopping hooks
/titles [topic] — A/B title variants
/genthumbnail [title] — Thumbnail concepts
/gencaption [topic] — Instagram caption + hashtags
/repurpose [topic] — 1 video → Reels + Stories + Tweets

<b>📊 ANALYZE</b>
/competitor [channel] — Reverse-engineer a channel
/gaps [niche] — Find content gaps
/seo [topic] — Keyword analysis
/feedback [url] [views] [ret%] — Log performance
/report [week|month] — Content performance report

<b>📚 KNOWLEDGE</b>
/learnfrom [url] — Learn from a YouTube channel
/references — List reference channels
/relearn — Re-analyze all channels
/addbook Title | Author — Add book to library
/books — View book library
/bookidea [topic] — Search books for ideas

<b>📝 VIDEO TOOLS</b>
/transcribe [url] — Extract YouTube transcript
/studyvideo [url] — Deep study: hooks, structure, reel cuts
/ideas [date] — View ideas by date
/ideas saved — View saved ideas

<b>📄 FATURAS</b>
/amazon [YYYY-MM] [--force] — Recolher faturas Amazon
/uber [YYYY-MM] [--force] — Recolher faturas Uber
📸 Send photo of invoice → Auto-files

<b>🔬 AUTORESEARCH</b>
/autoresearch [target] [rounds] [--dry] — Run prompt optimization
/evalscore [target] — Score current prompt without mutation

<b>🧩 SKILLS</b>
/skills — List installed skills with status
/skill [name] — Detail view of a skill
/skill [name] enable|disable — Toggle a skill on/off

<b>🔌 CONNECTIONS</b>
/connect google — Link Google Calendar, Drive, Gmail
/connect outlook — Link Outlook Calendar, Email, To Do
/connections — View connected accounts

<b>🔧 SYSTEM</b>
/help — This menu
/status — Current state overview
/clear [domain] — Clear conversation history
/version — Bot version and uptime

💡 Just type naturally — I'll route to the right domain.
🌐 Portal: http://your-server:8200`;
