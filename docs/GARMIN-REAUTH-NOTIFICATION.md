# Garmin Re-auth Notification Contract

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

No iOS code change is required for Stage 1.

The existing notification center / inbox contract can surface the notification
as an action-required item. The dedicated Garmin reconnect UI can later read
`data.reauthEndpoint` and launch the manual verification flow.
