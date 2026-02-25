# Integration Notes — MBS Master Orchestrator

## Architecture Overview

```
                    ┌─────────────────────────┐
                    │   MBS Master            │
                    │   Orchestrator v1.8.0   │
                    │                         │
  CSV imports ───>  │  metrics/import/        │
  (GSC, GA4,        │  ├── gsc.csv            │
   Ads, CRM)        │  ├── ga4.csv            │
                    │  ├── outcomes.csv       │
                    │  ├── search-terms.csv   │
                    │  └── zip_metrics.csv    │
                    │                         │
  Manual update --> │  config/flow_state.json │ <-- lead counts from CRM
                    │                         │
                    │  Outputs:               │
                    │  ├── metrics/snapshots/  │──> read by Marketing Operator
                    │  ├── config/            │──> read by Marketing Operator
                    │  ├── bundles/week-N/    │
                    │  └── config/learned.json│
                    └─────────────────────────┘
                              │
                    reads via filesystem
                              │
                              ▼
                    ┌─────────────────────────┐
                    │   MBS Marketing         │
                    │   Operator v1.1.0       │
                    │                         │
                    │  Reads:                 │
                    │  ├── flow_state.json    │
                    │  ├── flow_control.json  │
                    │  ├── geo_priority.json  │
                    │  └── snapshots/*.json   │
                    │                         │
                    │  Produces:              │
                    │  ├── GBP posts          │
                    │  ├── Google Ads RSA     │
                    │  ├── Website modules    │
                    │  └── Insights reports   │
                    └─────────────────────────┘
```

## Files the Marketing Operator Reads

| Orchestrator File | Marketing Operator Uses For |
|---|---|
| `config/flow_state.json` | Near-cap detection, upgrade deficit, backlog check |
| `config/flow_control.json` | Cap thresholds (hard/soft/overflow), minUpgradeRatio |
| `config/geo_priority.json` | Target ZIP list, weights for local proof content |
| `metrics/snapshots/*.json` | Service spike detection (top conversion pages), top queries |

## Data Flow Sequence

1. **You** update `config/flow_state.json` with current lead/backlog numbers
2. **You** place CSVs in `metrics/import/` and run `metrics --import`
3. **Orchestrator** generates snapshots in `metrics/snapshots/`
4. **Marketing Operator** reads these files and generates content packs
5. **You** review and approve content before publishing

## No Shared Database

The two repos communicate ONLY through JSON files on the filesystem. No API, no database, no network calls. This is intentional — it means:

- Either repo can be updated independently
- You can test the marketing operator with fake orchestrator data
- The orchestrator never needs to know the marketing operator exists
- Both repos work offline

## Adding a New Signal

To add a new signal from orchestrator to marketing operator:

1. Add the field to the relevant config JSON in the orchestrator
2. Add the field to the appropriate TypeScript interface in `mbs-master-orchestrator/types/index.ts`
3. In `mbs-marketing-operator/core/leadDriven/signalReader.ts`, read the new field
4. In `mbs-marketing-operator/core/leadDriven/ruleEngine.ts`, add a rule that uses it
5. Add tests in both repos
