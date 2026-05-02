# Training iOS contract and UI review

## Static review

- Remote Training home payloads now pass through `TrainingHomeViewStateBuilder.dedupSecondaryActions`, so WeekProtection and CoachReview no longer show duplicate `Atualizar coach` / `Ver plano da semana` CTA pairs.
- `TrainingView` no longer renders the redundant Week Journey section.
- `WeeklyPlanView` consumes plan-level sync status instead of deriving a misleading binary state from individual sessions.

## Tests

Command run in `/tmp/nexus-training-hardening-ios`:

```bash
xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -destination 'id=A0B13967-B5DE-4E6F-897D-F1E409093F94' -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 -only-testing:"Nexus HubTests/TrainingHomeContractResolverTests" -only-testing:"Nexus HubTests/TrainingHomeViewStateBuilderTests" -only-testing:"Nexus HubTests/TrainingWeekResponsePlanSyncStatusTests" -only-testing:"Nexus HubTests/TrainingTodayCalendarSyncStateTests"
```

Result: 40/40 tests passed on one booted iPhone 17 Pro simulator.

## Physical device

No physical iPhone appeared in `xcodebuild -showdestinations` for this worktree. Physical-device Training interaction, account switching, and real responsiveness remain unverified in this pass.
