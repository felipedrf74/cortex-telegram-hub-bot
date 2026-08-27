# Data Retention

## Account Deletion

Nexus Hub deletes user-owned product data during Article 17 account deletion.
The deletion service removes local OAuth sessions, push tokens, Garmin sessions,
per-user configuration rows, health/training/content/finance/cooking records,
and the user record itself inside one database transaction after best-effort
third-party OAuth revocation. Content script deletion first fences local work,
cancels every active provider Batch, and requires confirmed deletion of every
known provider input, output, and error file. A provider refusal leaves the
local Batch identity intact and fails the erasure request closed so the owner
can retry without orphaning remote private data.
Upload and Batch-create intent is persisted before each provider call using
only a content-free stage filename/digest. Account deletion reconciles any
intent missing a local provider identifier through a bounded provider listing;
ambiguous or truncated inventories fail closed before cancellation or deletion.
An empty listing is not immediate deletion proof: absence must be observed at
least twice, at least 60 seconds apart, after a 15-minute provider-visibility
grace. The same reconciliation gates the 30-day provider-file retention sweep.
While the parent job is still lease-owned and active, the runtime advances that
same durable observation state and atomically consumes a completed absence
proof before one new provider mutation; a crash starts a fresh proof window.
That sweep advances a stable parent-time/job/stage cursor past reconciliation
failures so an unavailable oldest intent cannot starve later provider objects.
Intent reconciliation and known-file deletion share one bounded, alternating
page budget with a durable cross-run turn, so neither backlog can starve the
other even when the scheduler permits one page per invocation.

Invoice bytes are owned by a durable manifest before filesystem creation, and
new manifest writes plus filing-metadata inserts share the account-deletion
fence's SQLite writer boundary. Account deletion renews its token-bound fence
while external cleanup is pending, drains admitted writes, reconciles expired
crash-window manifests by deleting the locator or proving it absent, and stores
deletion proof before removing ownership rows. Queue flushers first acquire an
expiring SQLite claim on pending rows and renew it throughout each filing call,
so overlapping scheduler/manual runs do not file the same spool concurrently.
Before reading any bytes, a worker requires the row's exact tenant/user,
filesystem backend, and live `stored` spool manifest. Queue retries bind a full
source digest and queue-row identity to the stored-object manifest. A later
claim adopts only that exact intent and re-verifies the first stored payload
against its persisted digest, byte count, and MIME, so changed compression
settings or a changed candidate key cannot create or silently replace an
object written immediately before claim loss. Production Linux spool creation,
reads, and deletion traverse from a held filesystem-root descriptor and remain
bound through procfs-relative operations; other platforms fail closed. Before
unlinking a queue spool or stored object, cleanup commits a token-bound
`deleting` journal containing the validated device/inode identity. Success then
requires parent fsync, canonical-name absence, and zero links on that same open
inode. A stale attempt can resume only when the canonical entry still matches
the journaled identity; a missing, replaced, identity-less, or escaped inode
remains blocked for operator reconciliation. Legacy queue/filing rows without
a manifest receive an exact tenant/user manifest before any unlink; a
pre-journal `deleted` manifest cannot prove those row-owned bytes absent unless
it also carries the device/inode journal and a current descriptor-bound check
confirms that its canonical locator remains absent. After a row becomes filed or
failed, the scheduler invokes cleanup even with no pending rows. A proven
manifest deletion is recoverable separately if a crash precedes persistence of
`invoice_queue.local_file_deleted_at`. A live write/deletion lease, unsupported
storage backend, unsafe path, or missing proof fails erasure closed. Historical
SCP paths are separate copies even after backfill and require checksum-bound,
mounted-root deletion proof. A pre-activation inventory reconciles canonical
no-row object/queue files into manifests; unsafe or ownerless artifacts block
readiness instead of being guessed or silently removed.
Subject-access export includes the user's filing, queued analysis, vendor-rule,
fiscal-profile, fiscal-send document, and content-free manifest metadata, but
never internal spool paths, object locators, write tokens, raw error text,
unknown provider result keys, or invoice bytes in the JSON response.

## Audit Trail Exception

`audit_trail` is retained for legal forensics and deletion proof under GDPR
Article 17(3)(e). Ordinary security and administrator actions on an explicit
allowlist have a bounded retention period of 12 calendar months, calculated as a
calendar boundary rather than a fixed 365-day interval. `decrypt` audit is
included in that same policy. Fiscal, invoice, Nexus Points,
billing-checkout, and administrative-credit actions are classified as
statutory billing/fiscal evidence and are excluded from the generic 12-month
pruner. The exclusion also covers the governed billing, fiscal, invoice, Nexus
Points, and AI-credit resource families when a predecessor uses a generic
`create`, `update`, or `delete` action. Personal finance-tracker audit remains
inside the 12-calendar-month privacy boundary; it is not statutory product-billing
evidence. Account export/deletion and privacy-consent proof also remain outside
the generic sweep under their legal-proof policy. Unknown future action names
are retained until they receive an
explicit governed classification, so adding an action cannot silently delete
regulated evidence. Audit rows store IDs, action names, resources, timestamps,
and redacted details; they are not used to reconstruct product content after
account deletion.

## AI And Content Retention

Terminal Content script jobs have their encrypted requests, results, and
checkpoints pruned after 30 days. A Batch-backed job is not pruned until
deletion of any provider-side input, output, and error files has been recorded.
The non-sensitive job and Batch identities, usage evidence, and billing links
remain; checkpoint deletion and encrypted-field tombstoning are atomic. A
durable cleanup-start fence is written before the remote deletion call. Retry
and late Batch persistence honor that fence, while a short-lived resumable
claim prevents concurrent cleanup workers from deleting the same files.
Unresolved upload/create intents block the local private-material tombstone
until the provider artifact is deleted or durable repeated-absence proof exists.

Content-free `skill_inference_runs` telemetry and its attempts are pruned after
90 days once the run is terminal. Admitted and running rows remain available
for recovery even when their timestamps are older than the retention window.
Content-free `local_inference_safety_incidents` evidence is retained for 365
days. Each scheduled sweep drains indexed pages with a short writer transaction
per page, is capped per invocation, and reports the remaining eligible count,
oldest eligible timestamp, and age in days when a backlog remains.
Provider-file cleanup uses a stable page cursor so a failed provider deletion
cannot starve later eligible rows in the same sweep. Its durable branch turn
also alternates unresolved-intent and known-file pages across invocations.
Timestamp ordering and
age reporting normalize both SQLite-space and ISO UTC forms through
`julianday`; terminal parents whose provider Batch has not settled are reported
as a blocked-active backlog rather than disappearing from retention telemetry.

Raw Garmin health signals and calendar context are never captured to local
coach-payload files. A fresh coach analysis may route that private context to
the configured cloud provider chain only when the authenticated request grants
per-request authority and the operator privacy policy independently permits raw
private-data routing. The provider boundary enforces both conditions before it
examines provider availability, so a fallback cannot bypass the refusal.

New generic webhook subscriptions and events require a positive account owner.
Incoming events must match the exact active subscription owner and provider;
their idempotency keys are owner-, provider-, and subscription-scoped under an
immediate write transaction. Release A keeps new values plaintext while
`WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED=false`, preserving its predecessor as
a compatible rollback target. Only a later protected release may enable the
per-user `nexus-webhook-json-v1` authenticated-encryption envelope after
Release A is verified as the rollback floor; reads accept both formats during
the transition. Events remain under the existing 30-day processed/ignored
retention bound. Subject access decrypts only that owner's safe
metadata/payload and omits signing secrets and headers; account deletion removes
the owner-scoped subscription, event, and delivery rows.
Pre-boundary `user_id=0` rows cannot be decrypted, listed, replayed, or used to
authorize delivery and must be reconciled or removed through the approved
operator procedure before release.
