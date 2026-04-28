# Training Profile Open Items

## High Priority

1. Render profile quality in iOS and persist answers.

   The engine now exposes `profileQuality` on the app-facing coordinated plan. iOS should render confidence, planning-risk flags, and targeted prompts, then persist structured answers so the next generation no longer relies on the same missing-data assumptions.

2. Add explicit questionnaire fields for session duration.

   The model can already read duration fields such as `session_duration_minutes`, but the current questionnaires do not consistently ask for them. Add duration questions to fitness, gym, running, and cycling setup flows.

3. Add explicit modality-priority input for hybrid users.

   Hybrid plans need to know whether strength, running, cycling, or balance wins when the week gets crowded. Today this can be inferred from objective/notes but should become a first-class question.

## Medium Priority

1. Persist normalized profile snapshots.

   The normalized profile is currently computed at plan-generation time. Persisting a versioned snapshot would make audits and before/after plan comparisons easier.

2. Add feedback answer ingestion.

   The follow-up model can ask for too-hard/too-easy/too-long feedback. The next layer should store those answers and feed them into progression, substitutions, and adherence simplification.

3. Expand equipment vocabulary and confidence.

   Equipment still uses simple keyword matching. It should eventually understand cable machines, leg press, hotel gym, CrossFit box, university gym, and disliked/unavailable movements.

4. Better recovery baseline without wearables.

   Users without Garmin/Apple Health should have a short subjective recovery baseline questionnaire so the engine can avoid treating missing wearable data as neutral truth.

## Low Priority

1. Localized follow-up prompts.

   Follow-up prompts are currently English engine strings. iOS or API response mapping should localize them.

2. Sex/gender-aware physiology.

   Keep this out of generic planning until explicit, relevant user-provided context exists and the behavior is tested. Avoid stereotypes.
