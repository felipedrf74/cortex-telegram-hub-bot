# Cooking Security Red Team

Date: 2026-04-30

## Scenarios Covered By Tests

- Same user, tenant A recipe cannot be read/updated/deleted from tenant B.
- Same user, tenant A meal plan cannot be read/deleted from tenant B.
- Same user, tenant B cannot overwrite a tenant A meal slot.
- Same user, tenant A shopping list cannot be read from tenant B.
- Allergy conflict blocks the meal-plan assessment.
- Expired pantry item blocks use.

## Scenarios Still To Add

- Chat prompt injection asks for another tenant's pantry.
- Tool call tries to set a meal in another tenant.
- iOS tenant switch stale Cooking cache.
- Portal/admin access to private Cooking preferences.
- Malicious recipe source text instructs model to ignore restrictions.
- Medical-diet treatment request.

## Current Verdict

PASS WITH CONDITIONS. Backend service scope is improved, but full red-team coverage needs Chat/tool invocation and frontend cache tests.

