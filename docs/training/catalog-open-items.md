# Training Catalog Open Items

## High Priority

1. Calendar-aware hybrid interference needs a second pass.

   The current guardrails can move lower-body strength away from key endurance work, but the move target is still day-based rather than full load-aware. A future pass should consider long ride/run adjacency, existing same-day load, and user preference windows together.

2. Running public session taxonomy is still compressed.

   Hill repeats and tempo progression currently reuse `interval_run` / `threshold_run` to preserve iOS compatibility. A future contract version could expose richer session roles as metadata or new safe enum values once all clients support unknown/future cases.

3. Strength catalog still needs deeper machine-specific and barbell-specific breadth.

   Priority 10 added leg press, cable, chest-press machine, and limited-equipment variants. The next layer should add hamstring curl, hack squat, trap bar, sled, assisted pull-up, cable lateral raise, and machine-supported substitutions once `EquipmentAccess` can represent equipment confidence and user preference rather than just boolean access.

## Medium Priority

1. Cycling still needs event-specific specialization.

   Current cycling roles cover FTP/general fitness well. Gran fondo, crit, time-trial, and climbing profiles should get distinct archetype preferences later.

2. Progression should eventually alter exercise selection, not only session ordering.

   Week-index rotation creates structured novelty. The next depth layer should use training history and feedback to bias progression/regression families.

3. Template metadata should graduate into a validated schema.

   Priority 10 added role/equipment/experience/progression metadata to templates and tests it at source level. A follow-up should use a runtime schema validator so authoring mistakes fail before deploy.

4. Warm-up/cool-down content should become structured blocks.

   Today warm-up needs exist in exercise metadata and descriptions. A richer block model could expose specific prep/cooldown items to iOS without parsing prose.

5. Substitution ranking can include actual equipment confidence.

   The current substitution path uses binary availability. It should eventually prefer the user's liked/effective movements and avoid disliked movements.

## Low Priority

1. Add swim catalog depth.

   This request focused Gym, Running, Cycling, and Hybrid. Swim remains outside this pass.

2. Human coach review labels.

   The evaluation harness is deterministic. Human coach labels would improve subjective quality calibration.

3. Better session naming localization.

   Template titles remain English. Portuguese localization should happen at the presentation layer or through localized title fields.
