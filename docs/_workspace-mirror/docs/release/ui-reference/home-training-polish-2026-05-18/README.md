# Home, Tasks, Training, Inbox Polish Reference — 2026-05-18

This folder tracks the screenshot set supplied in the Codex thread for the focused iOS polish pass. The binary attachments live in the chat transcript; this README preserves the acceptance criteria and image-to-work mapping so QA can review the same scope even if chat attachments expire.

## Reference Map

| Ref | Screenshot content | Acceptance criteria |
| --- | --- | --- |
| Image 1 | Home `Semana` / `Plano do dia` segmented controls | Both controls read as tappable buttons with a capsule hit area, icon/chevron affordance, pressed state, 44pt minimum target, and existing accessibility identifiers. |
| Image 2 | Launch screen in dark mode with nearly black `Nexus Hub` label | Touched launch/home surfaces must avoid black text on dark backgrounds and low-contrast white text in light mode. |
| Image 3 | Home day dial clock vs device clock | The visible time and day-dial marker must use the same `now`, timezone, and refresh cadence. |
| Image 4 | Tasks Smart Views Inbox orange count vs Lists Inbox dark count | Lists Inbox count badge uses the same orange visual treatment as Smart Views Inbox in light and dark mode. |
| Image 5 | Inbox top plus button | Top add buttons use the Tasks-style elevated circle with orange plus, not a filled orange button. |
| Image 6 | Training `Weekly consistency` / `Progression by sport` sections | Expanding these sections gives visible feedback within 150ms and loads chart data only after expansion. |
| Image 7 | Training alert card with white text on light-blue card | Training degraded/partial-read alerts use adaptive semantic text colors. |
| Image 8 | Home header reference | Date/time context is a small caption above a one-line greeting; non-critical system states are inline pills; bell/avatar visuals are 28px circles. |
| Image 9 | Briefing report reference | Morning, midday, and end-of-day briefing reports render glanceable metric cards, agenda, tasks, quick actions, and a sticky-style primary action. |

## Implementation Notes

- Canonical implementation lives in the iOS app repo under `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`.
- The pass preserves the Token-Zero rule: Home, Tasks, Inbox, Training, and Reports continue to use REST/repository flows.
- No screenshot binaries were generated from the prompt attachments in this session; if standalone image assets are needed later, re-upload the originals and place them in this folder as `image-01.png` through `image-09.png`.
