# {{sliceId}}: {{sliceTitle}} — UAT

**Milestone:** {{milestoneId}}
**Written:** {{date}}

## UAT Type

- UAT mode: {{artifact-driven | live-runtime | human-experience | mixed}}
- Why this mode is sufficient: {{reason}}

## Preconditions

{{whatMustBeTrueBeforeTesting — server running, data seeded, etc.}}

## Smoke Test

{{oneQuickCheckThatConfirmsTheSliceBasicallyWorks}}

## Test Cases

### 1. {{testName}}

1. {{step}}
2. {{step}}
3. **Expected:** {{expected}}

### 2. {{testName}}

1. {{step}}
2. **Expected:** {{expected}}

## Edge Cases

### {{edgeCaseName}}

1. {{step}}
2. **Expected:** {{expected}}

## Failure Signals

- {{whatWouldIndicateSomethingIsBroken — errors, missing UI, wrong data}}

## Requirements Proved By This UAT

- {{requirementIdOr_none}} — {{what this UAT proves}}

## Not Proven By This UAT

- {{what this UAT intentionally does not prove}}
- {{remaining live/runtime/operational gaps, if any}}

## Notes for Tester

{{anythingTheHumanShouldKnow — known rough edges, things to ignore, areas needing gut check}}
