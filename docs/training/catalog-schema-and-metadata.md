# Training Catalog Schema And Metadata

## Exercise Metadata

Every exercise in `src/services/coach-kernel/knowledge/entities/exercises.json` should carry:

| Field | Purpose |
| --- | --- |
| `movementPattern` | Squat, hinge, push, pull, single-leg, core, carry, or mobility role. |
| `equipment` | Exact equipment requirements used by substitution logic. Empty means bodyweight/no special equipment. |
| `fatigueCost` | Low, medium, high, or very high fatigue classification. |
| `substitutions` | Ordered fallback IDs in the same coaching family. |
| `complexity` | Beginner/intermediate/advanced/expert technique cost. |
| `spinalLoading` | Low/moderate/high axial-loading signal. |
| `unilateral` | Whether the movement is one-sided. |
| `primaryPurpose` | Strength, hypertrophy, power, stability, mobility, or conditioning. |
| `contraindicationFlags` | Optional discomfort flags used by safety substitutions. |
| `warmupNeeds` | Prep tags the engine can use to build relevant warm-up guidance. |

## Workout Template Metadata

The template schema remains backward compatible. New metadata fields are optional at the TypeScript level, but required by catalog-depth tests for running, cycling, and strength source templates.

| Field | Purpose |
| --- | --- |
| `sessionRole` | Human/coaching role such as `tempo_progression`, `hybrid_recovery_support`, or `minimum_effective_dose`. |
| `experienceFit` | Experience levels that can receive the template without extra downgrade logic. |
| `equipmentProfile` | Equipment/environment shape such as `full_gym`, `treadmill`, `bike_trainer`, or `hotel_gym`. |
| `variantTags` | Searchable planning tags for variety and evaluation. |
| `recoveryScenarioTags` | Optional fatigue/recovery cases where the template is useful. |
| `timeRangeMinutes` | Intended duration range for constrained-week validation. |
| `progressionTarget` | What should progress first when the user adapts well. |
| `substitutionFamily` | Family key for role-preserving substitutions. |

## Selection Rules Added

| Engine | New Selection Behavior |
| --- | --- |
| Strength | Athletes without gym access, or with travel/hotel/limited-equipment constraints, receive explicit limited-equipment variants before normal equipment substitution runs. |
| Running | Novice runners receive run-walk and controlled-fartlek options. Hybrid users get low-fatigue flush support. Travel weeks prefer low-friction travel runs. |
| Cycling | Travel weeks prefer short/travel ride options. Hybrid strength weeks prefer flush rides. Low recovery still routes to recovery rides. |

## Guardrail

Catalog expansion must satisfy `__tests__/services/coach-kernel-catalog-depth.test.ts`, which verifies:

- all exercise metadata is present
- substitution references are valid
- running/cycling/strength templates have role metadata
- limited-equipment strength plans avoid barbell/machine-first prescriptions
- novice running materially changes generated sessions
- hybrid cycling support and travel running variants are selected
