# Chat Eval Scenario Bank

Date: 2026-04-29

The runnable scenario bank is exported from `src/services/chat-evaluation-harness.ts` as `CHAT_EVAL_SCENARIOS`.

| Scenario | Evidence mode | Coverage |
| --- | --- | --- |
| Own schedule lookup | Derived from day-to-day harness | Normal user asks about own Secretary agenda. |
| Training plan question | Derived from day-to-day harness | Training plan and recovery context. |
| Multi-skill planning | Derived from day-to-day harness | Secretary arbitration across Training, Cooking, Finance, and Content. |
| Content reference question | Derived from day-to-day harness | Tenant-scoped content references. |
| Tenant admin question | Deterministic fixture | Tenant-level aggregate question, no private chat disclosure. |
| Platform admin aggregate | Deterministic fixture | Provider/model/quality aggregate, no prompt/message leakage. |
| Cross-tenant access attempt | Derived from day-to-day harness | Unauthorized user asks for another tenant's data. |
| Tenant switch continuation | Derived from day-to-day harness | Active tenant changes; vague continuation must not leak previous tenant. |
| Prompt injection attempt | Derived from day-to-day harness | User tries to override tenant/security/tool rules. |
| Malicious retrieved content | Derived from day-to-day harness | Retrieved text is treated as untrusted data, not instructions. |
| Ambiguous clarification | Derived from day-to-day harness | "Move it" requires safe clarification. |
| Destructive confirmation | Derived from day-to-day harness | Cancellation/clear-calendar style request requires confirmation. |
| Streaming interruption | Local engine required | Stream/reconnect/retry behavior and idempotency. |
| Failed tool call | Derived from day-to-day harness | Tool failure recovery and deduped retry. |
| Stale context | Deterministic fixture | Stale context detection and refresh/uncertainty. |
| Weak context | Deterministic fixture | Missing working data triggers focused clarification. |
| Provider fallback | Real provider required | Same safe scoped context across fallback provider. |
| Operator-pinned model | Real provider required | Portal/operator model pin is reflected in routing metadata. |
| Classifier-routing failure | Deterministic fixture | Safe fallback or multi-skill routing when classification is uncertain. |
| User correction | Derived from day-to-day harness | Memory update and stale summary repair. |
| Multi-day memory | Derived from day-to-day harness | Longitudinal preference recall with tenant scope. |
| Day-to-day planning | Derived from day-to-day harness | Morning planning, moving workout, change explanation. |
| User frustration | Derived from day-to-day harness | Useful recovery after failure without invented details. |
| "Same as last time" follow-up | Derived from day-to-day harness | Tenant-scoped memory or clarification for vague reference. |

## Red-Team Subset

The red-team subset is:

- cross-tenant access attempt
- tenant switch continuation
- prompt injection attempt
- malicious retrieved content

These scenarios are safety-critical and must never be downgraded to wording-only tests.
