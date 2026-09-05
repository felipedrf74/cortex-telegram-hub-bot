# Development Prompt Guidance

Owner: Felipe
Reviewed: 2026-09-05

Optional prompt-writing notes, not runtime routing or model-selection policy.
Felipe freely selects the model and reasoning effort. Never change either to
apply this document. Unknown models use the shared task structure below.
Do not equate effort labels across products or copy API settings into a CLI.

## Shared task structure

> Deliver [observable outcome]. Context: [relevant repository/domain facts].
> Scope and authority: [owned work, exclusions, existing permissions].
> Acceptance: [required behavior and important failure cases].
> Evidence: [risk-selected checks and delivery level actually requested].

Reference the development policy; do not paste it into every task. Include
only context that changes the result. Preserve user choices across handoffs.

## Small adjustments for the selected model

| Selected model | Adjust the prompt only when useful |
| --- | --- |
| Astra | Make routine autonomy and material-question boundaries explicit. Resolve conflicting skills before adding instructions. Bound verification and delegation by task shape. |
| GPT-5.6 Sol / Luna | Favor lean instructions and clear completion criteria. Remove one redundant instruction group at a time; preserve necessary examples and required evidence. Concision must not omit behavior. |
| Opus 5 | State scope, response length and progress cadence. Bound delegation. Avoid generic repeated self-check requests; keep concrete Nexus risk gates and independent reviews. |
| Fable 5.1 | Complete the requested scope without adjacent fixes. Prefer targeted edits. Request useful updates and preserve decisions/unfinished work after compaction. Ask for current-source verification when needed. |
| Grok 4.6 | Supply reachable repo context and explicit tool/authority boundaries. Do not depend on home-directory files. Preserve task decisions through long sessions. These are Nexus working practices, not unsupported claims of Grok-specific prompting behavior. |

## Sources and maintenance

[Astra](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra),
[Sol/Luna](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6),
[Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5),
[Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1),
[Grok 4.6](https://docs.x.ai/developers/grok-4-6).

Recheck official sources when the model/harness changes or a repeated workflow
failure appears. Keep model advice provisional until a representative Nexus
task supports it. Compare completion, evidence, avoidable questions, repeated
checks, latency and rework; fewer tokens alone are not a quality improvement.
Do not weaken project checks because a provider recommends less self-review.
Do not add a model registry, API migration, fallback or runtime prompt change
as part of development-guidance maintenance.
