# Tech-Debt 2026-05 Validation Archive Index

Status: archive
Owner: Codex
Last verified: 2026-05-07
Update policy: archive index for the 2026-05 sweep; update only when adding
missing historical evidence.

## Chronological Table

The archive has no standalone `codex-batch-1-remediation.md`; Batch 1 evidence
is preserved in `codex-tech-debt-pass.md` and `codex-validation-matrix.md`.
Batch 17 has revalidation evidence only in this archive; no remediation report
was reconstructable during Batch 24.

| Batch | Branch / stack | Final SHA | Verdict | Key wins | Evidence link |
|---:|---|---:|---|---|---|
| 1 | A1-A7 independent branches | multiple | Phase A complete with conditions | audit fix, Sentry gate, email hash, migration gate, allowlist, WhatsApp deletion, sharp types | `codex-tech-debt-pass.md` |
| 2 | B1-B6 | multiple | Complete with conditions | auth negative tests, coverage floor, model constants, JWT helper, timezone resolver, iOS scope | `codex-batch-2-remediation.md` |
| 3 | revalidation only | n/a | Evidence gap | revalidated next pass; no remediation artifact found | `codex-batch-3-revalidation.md` |
| 4 | D1-D6 | multiple | Staged feature branches | migration safety, health extension, restore alerts, retry helper, mock factories, runbooks | `codex-batch-4-remediation.md` |
| 5 | E1-E6 | multiple | Complete with conditions | bootloader docs, OPEN_ITEMS rotation scaffold, observability extraction, Python pytest bootstrap | `codex-batch-5-remediation.md` |
| 6 | F0/F2/F5 | `49cf23a1` for F5 | Complete with conditions | merge safety analysis, Python pytest expansion to 53 | `codex-batch-6-remediation.md` |
| 7 | TD-G1 | see report | Closed source branch | Python pytest expansion to 71 | `codex-batch-7-remediation.md` |
| 8 | TD-H1 | `e637f219` | Closed source branch | Python pytest expansion to 91 | `codex-batch-8-remediation.md` |
| 9 | C5/E1/F1/F2/F3/F4/E8 stacks | multiple | Closed source stacks | Anthropic wrapper, health validation, strict mock ratchet, observability shim removal, mirror sync | `codex-batch-9-remediation.md` |
| 10 | G1-G5 | `4ad52c63` | Closed source stack | docs-audit historical cleanup and frontmatter completion | `codex-batch-10-remediation.md` |
| 11 | H1-H5 | `e9792127` | Closed source stack | residual broken-link cleanup and release docs discipline | `codex-batch-11-remediation.md` |
| 12 | I1-I5 | see report | Closed analysis/docs | D5/F4 merge-readiness and cross-stack sequencing | `codex-batch-12-remediation.md` |
| 13 | J1-J4 | see report | Complete in source | mock ratchet planning, Python pytest to 114, cross-repo resolver | `codex-batch-13-remediation.md` |
| 14 | K1-K5 | see report | Partial, stop honored | quick-win mechanical sweep; saved-ideas isolation blocker found | `codex-batch-14-remediation.md` |
| 15 | L0-L4 | `e1865147`, `a5cb27a1` | Closed source stack | scheduler registry decomposition; 34-job inventory invariant | `codex-batch-15-remediation.md` |
| 16 | M1-M5 | `c47aae56`, `add2a2cb` | Partial source closure | version drift and deploy skip-verify audit closed; Python/M2 blocked | `codex-batch-16-remediation.md` |
| 17 | N1-N5 | n/a | Evidence gap | iOS P2 cluster revalidation only; closure report missing | `codex-batch-17-revalidation.md` |
| 18 | O1-O4 | `4e7e89df`, `7449b65c` | Partial, stop honored | coach-state invalid-user fix-first; broader state pack blocked | `codex-batch-18-remediation.md` |
| 19 | P1-P4 | `0bf095e2`, `4bf712a6`, `c887e96b` | Blocked, stop honored | fiscal/invoice guards; content-references admin finding discovered | `codex-batch-19-remediation.md` |
| 20 | Q1-Q4 | `266094e5`, `9cd72866`, `4822f83e` | Primary closed, side-task blocked | content-references admin split; six-module state isolation pack | `codex-batch-20-remediation.md` |
| 21 | R1-R8 | R8 merge stack | Closed / skips honored | PM2 health, JWT rotation, GH reachability, Python 135, genai phase 1 | `codex-batch-21-remediation.md` |
| 22 | S1-S3 | `16d05f1b`, `5d1a722b` | Partial | D5/F4 refreshed; genai phase 2 blocked; retro Batch 20 report | `codex-batch-22-remediation.md` |
| 23 | T1-T7 | `bf676103` final tip | Closed / skips honored | D5/F4 merged, genai migration completed, old SDK removed | `codex-batch-23-remediation.md` |
| 24 | U1-U5 | Batch 24 closure | In progress in this branch | sweep dossier, index, OPEN_ITEMS rotation, staged CLAUDE update | `codex-batch-24-remediation.md` |

## Per-Finding Cross-Reference

| Finding | Batches |
|---|---|
| P0-01 | 2 |
| P0-02 | 2 |
| P0-03 | 2 |
| P0-04 | 2 |
| P0-05 | 1 |
| P0-06 | 1 |
| P0-07 | 1 |
| P0-08 | 1 |
| P1-09 | 4 |
| P1-10 | 2 |
| P1-11 | 10, 11 |
| P1-12 | 10, 11 |
| P1-13 | 14 |
| P1-14 | 15 |
| P1-15 | 1, 4 |
| P1-16 | 2 |
| P1-17 | 14 |
| P1-18 | 2, 21 |
| P1-19 | 5, 24 |
| P1-20 | 10, 11 |
| P1-21 | 4 |
| P1-22 | 4 |
| P2-23 | 2 |
| P2-24 | 18, 19, 20, 21 |
| P2-25 | 4 |
| P2-26 | 1 |
| P2-27 | 1 |
| P2-28 | 1 |
| P2-29 | 16 |
| P2-30 | 9 |
| P2-31 | 17 evidence gap |
| P2-32 | 14 |
| P2-33 | 5, 9 |
| P2-34 | 16 |
| P2-35 | operator-only carryover |
| P2-36 | 17 evidence gap |
| P2-37 | 10, 11 |
| P2-38 | 21 |
| P2-39 | 4 |
| P2-40 | 21 |
| P2-41 | 17 evidence gap |
| P2-42 | 4, 9, 22, 23 |
| P2-43 | 4 |
| P2-44 | 21 |

## Per-Workstream Cross-Reference

| Workstream range | Batch | Verdict summary |
|---|---:|---|
| A1-A7 | 1 | complete with conditions |
| B1-B6 | 2 | complete with conditions |
| D1-D6 | 4 | staged source branches |
| E1-E6 | 5 | partial; E1/E4 blocked, E2/E3/E5/E6 staged |
| F0/F2/F5 | 6 | partial; F5 closed, F2 blocked |
| G1-G5 | 10 | closed source stack |
| H1-H5 | 11 | closed source stack |
| I1-I5 | 12 | merge-readiness and closure |
| J1-J4 | 13 | complete in source |
| K1-K5 | 14 | partial; stop honored |
| L0-L4 | 15 | closed source stack |
| M1-M5 | 16 | partial; M3/M4 closed |
| N1-N5 | 17 | evidence gap; revalidation only |
| O1-O4 | 18 | partial; O1 closed |
| P1-P4 | 19 | blocked; P1 closed, P2 finding found |
| Q1-Q4 | 20 | Q1/Q2 closed, Q3 blocked |
| R1-R8 | 21 | closed/skips honored |
| S1-S3 | 22 | S1 closed, S2 blocked |
| T1-T7 | 23 | closed/skips honored |
| U1-U5 | 24 | closeout docs-only batch |

## Frozen Baselines

| Baseline | Value | Established / reaffirmed |
|---|---:|---|
| Full backend verify floor | 6973 tests | Batch 23 T7, reaffirmed Batch 24 preflight |
| Python content-engine pytest floor | 135 tests | Batch 21 R4, reaffirmed Batch 24 preflight |
| P0 chat identity contract | 23/23 | Reaffirmed every batch; Batch 24 preflight |
| Cannot-skip-gate dashboard | 23/23 | Reaffirmed Batch 24 preflight |
| Partial mock strict baseline | 827 | Batch 22 S1, merged Batch 23 |
| docs:audit issue ceiling | 480 | Batch 23/24 |
| docs:audit audited markdown floor | 423 | Batch 23/24 |

## Evidence Gaps

- No standalone Batch 1 remediation filename exists; evidence is split between
  `codex-tech-debt-pass.md` and `codex-validation-matrix.md`.
- No Batch 3 remediation report was found; only revalidation is archived.
- No Batch 17 remediation report was found; only iOS revalidation is archived.
  Therefore P2-31, P2-36, and P2-41 are not counted as source-closed in the
  Batch 24 closeout dossier.
