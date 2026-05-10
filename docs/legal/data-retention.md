# Data Retention

## Account Deletion

Nexus Hub deletes user-owned product data during Article 17 account deletion.
The deletion service removes local OAuth sessions, push tokens, Garmin sessions,
per-user configuration rows, health/training/content/finance/cooking records,
and the user record itself inside one database transaction after best-effort
third-party OAuth revocation.

## Audit Trail Exception

`audit_trail` is retained for legal forensics and deletion proof under GDPR
Article 17(3)(e). Audit rows store IDs, action names, resources, timestamps, and
redacted details; they are not used to reconstruct product content after account
deletion.
