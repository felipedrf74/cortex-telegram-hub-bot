# Garmin Re-auth Notification Contract

Status: canonical
Owner: backend integrations lead (Felipe)
Last verified: 2026-06-16
Update policy: update when Garmin reauth flow or MFA-aware notification contract changes.

When Garmin passive refresh fails, the backend must NOT trigger a silent
credential login or an MFA email loop.

Instead it marks the user's Garmin connection as `needs_reauth` and emits a
durable inbox notification using the existing notification contract.

## Notification payload

- `type`: `content_action_required`
- `title`: `Garmin needs re-authentication`
- `body`: `Your Garmin session expired. Reconnect Garmin to restore training data in Nexus Hub.`
- `data.kind`: `garmin_reauth_required`
- `data.provider`: `garmin`
- `data.reauthEndpoint`: `/api/v1/garmin/reauth`
- `data.reason`: string describing why passive refresh failed

## iOS expectation

No iOS code change is required for the backend Stage 1 notification contract.

The existing notification center / inbox contract can surface the notification
as an action-required item. A dedicated Garmin reconnect UI must be verified in
the iOS workspace before any release claims native reconnect completion.
