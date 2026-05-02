# Training runtime performance review

## Read-path behavior

No evidence was found that simple Training summary/today reads trigger plan regeneration or real provider/model calls in local fixture mode. The local engine advertised fixture routing and the full Nexus smoke completed without real model calls.

## Local smoke evidence

- `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh doctor`: passed.
- `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh smoke`: 13/13 passed.
- `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh cross-skill-fixtures`: passed local fixture contracts.

## Remaining performance risks

- Physical-device Training navigation could not be measured because no physical iPhone was available to Xcode.
- Provider calendar read-back/sync latency was not measured in this pass.
- Larger all-weeks payload and rich Training home payload should be profiled during a signed-device navigation smoke.

## Recommendation

Keep Training reads as cached/summary paths and keep generation/sync explicit. If iOS responsiveness still regresses on device, capture request timing alongside Xcode Instruments to distinguish UI render cost from backend latency.
