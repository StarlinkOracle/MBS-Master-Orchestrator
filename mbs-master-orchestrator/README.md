# MBS Master Orchestrator

**v1.8.0** — Geo Priority vNext + Performance-Based Weight Learning (Conservative Mode)

**generatorVersion:** `1.8.0` | **schemaVersion:** `1.0.0` (unbroken since v1.0)

---

## Quick Start

```bash
# 1. Extract
tar xzf mbs-master-orchestrator.tar.gz
cd mbs-master-orchestrator

# 2. Install
npm install

# 3. Verify (519 tests)
npx tsx scripts/run-tests.ts

# 4. Import metrics (place real data first — see "Data Setup" below)
npx tsx cli/index.ts metrics --import

# 5. Generate weekly plan
npx tsx cli/index.ts plan

# 6. Generate weekly report
npx tsx cli/index.ts report
```

---

## What This System Does

The Master Orchestrator is the **brain** of the MBS marketing stack for a small (3–4 person) HVAC team. It:

1. **Ingests metrics** from Google Search Console, Google Analytics, Google Ads, and CRM/lead data
2. **Analyzes performance** per ZIP code, per service, per lead type
3. **Generates weekly plans** with prioritized marketing intents (what to do this week)
4. **Produces reports** with KPI dashboards, geo heatmaps, and actionable recommendations
5. **Governs lead flow** to prevent overwhelming the team (soft caps, ladder throttling)
6. **Learns from outcomes** and proposes weight adjustments (approval-gated, never auto-applies)

The **Marketing Operator** (`mbs-marketing-operator`) reads signals from this orchestrator to produce publish-ready content. See the integration section below.

---

## Directory Structure

```
mbs-master-orchestrator/
├── cli/index.ts              # CLI entry point
├── config/                   # All configuration (edit these)
│   ├── orchestrator.json     # Master config (week number, operators)
│   ├── conversion.json       # Close rates, avg ticket values, target CPL
│   ├── geo_priority.json     # 42 target ZIPs, weights, learning config
│   ├── flow_control.json     # Lead caps (hard/soft/overflow), quality discount
│   ├── flow_state.json       # UPDATE BEFORE EACH RUN (current lead counts)
│   ├── capacity.json         # Tech capacity, backlog limits
│   ├── mode.json             # Operating mode (CONSERVATIVE/BALANCED/AGGRESSIVE)
│   ├── lead_quality.json     # Call/form scoring weights
│   ├── kpi_targets.json      # Weekly KPI targets
│   └── learned.json          # Approval-gated proposals (auto-written)
├── core/                     # Business logic modules
│   ├── planner.ts            # Weekly plan generator
│   ├── report.ts             # Weekly report generator
│   ├── geo/                  # Geo priority engine + weight learner
│   ├── flow/                 # Flow governor (soft caps, ladder throttling)
│   ├── mode/                 # Conservative guard + tier expansion
│   ├── seasonality/          # Season gate (HEATING/COOLING/SHOULDER)
│   ├── calibration/          # Outcome calibration (modeled vs observed)
│   ├── leads/                # Lead quality scoring
│   ├── ads/                  # Waste hunter (search term analysis)
│   ├── metrics/              # Metric snapshot ingest
│   └── validators/           # Plan + report validation
├── metrics/
│   ├── import/               # DROP RAW DATA HERE
│   │   ├── gsc.csv           # Google Search Console export
│   │   ├── ga4.csv           # Google Analytics export
│   │   ├── outcomes.csv      # CRM: lead_type, qualified, sold, revenue
│   │   ├── search-terms.csv  # Google Ads search terms report
│   │   └── zip_metrics.csv   # Per-ZIP: zip, calls, forms, spend
│   └── snapshots/            # Auto-generated daily snapshots
├── bundles/                  # Auto-generated weekly bundles
├── scripts/run-tests.ts      # Test suite (519 tests, 86 suites)
├── types/index.ts            # All TypeScript interfaces
├── utils/index.ts            # Shared utilities
└── registry/tools.json       # Tool registry (29 tools)
```

---

## Data Setup — What to Put Where

### Before First Run

| File | Source | Format | Required? |
|------|--------|--------|-----------|
| `metrics/import/gsc.csv` | Google Search Console > Performance > Export | `page,query,impressions,clicks,ctr,position` | Recommended |
| `metrics/import/ga4.csv` | Google Analytics > Engagement > Export | `page,sessions,engagedSessions,bounceRate` | Recommended |
| `metrics/import/outcomes.csv` | Your CRM / lead tracking | `lead_type,qualified,sold,revenue` | For calibration |
| `metrics/import/search-terms.csv` | Google Ads > Search Terms > Export | `searchTerm,campaign,adGroup,impressions,clicks,cost,conversions` | For waste hunter |
| `metrics/import/zip_metrics.csv` | Your CRM / ads by ZIP | `zip,calls,forms,spend` | For geo learning |

### Before EVERY Run

**Update `config/flow_state.json`** with current numbers from your CRM/scheduling system:

```json
{
  "qualifiedLeadsToday": 8,
  "installLeadsThisWeek": 4,
  "repairLeadsToday": 5,
  "upgradeLeadsThisWeek": 2,
  "totalLeadsThisWeek": 15,
  "backlogHours": 24,
  "qualifiedLeadScoreToday": 72,
  "junkLeadRateEstimate": 0.10,
  "lowTicketRepairShareToday": 0.45
}
```

This is the single most important input. The flow governor and marketing operator both read this file to decide how aggressive to be.

---

## CLI Commands

```bash
# Import metrics from CSVs into snapshots
npx tsx cli/index.ts metrics --import

# Generate weekly plan (prioritized intents)
npx tsx cli/index.ts plan

# Generate weekly report (full dashboard)
npx tsx cli/index.ts report

# Run all 519 tests
npx tsx scripts/run-tests.ts
```

---

## Configuration Reference

### `config/geo_priority.json` — 42 Target ZIPs

All weights start at 1.0 (no bias). Excludes Denver County and Boulder County. The geo weight learner proposes increments of +/-0.05, bounded [0.80, 1.40]. Proposals written to `config/learned.json` with status `pending_approval` — never auto-applied.

Key fields:
- `baseZip`: "80212" (Russell Comfort Solutions HQ)
- `maxRadiusMiles`: 60
- `excludedCounties`: ["Denver", "Boulder"]
- `learning.mode`: "CONSERVATIVE"
- `learning.minLeadsPerZip`: 5 (minimum data before any weight change)

### `config/flow_control.json` — Lead Flow Caps

**Flow Modes** (with hardCap=12, softCapMultiplier=1.33, overflowMultiplier=1.66):

| Mode | Effective Leads | Behavior |
|------|----------------|----------|
| NORMAL | 0 – 12 | No restrictions |
| WAITLIST | 12 – 15.96 | Suppress tier2+3, tighten match types, boost upgrades |
| THROTTLE | 15.96 – 19.92 | Reduce bids 10%, suppress non-tier1 |
| SUPPRESS | > 19.92 | Block bid increases, reduce bids 15% |

**Quality Discount:** `effectiveLeads = raw x (1 - junkLeadRateEstimate)`. Junk leads don't count against caps.

**Install Cap Ladder** (replaces hard pause):

| Step | Ratio vs Cap | Action |
|------|-------------|--------|
| 0 | 0 – 100% | No restriction |
| 1 | 100 – 125% | Restrict install ads to tier1 only |
| 2 | 125 – 150% | + reduce install bids 15% |
| 3 | > 150% | Pause all install ads |

**Low-Ticket Repair Share:** When `lowTicketRepairShareToday > 0.55`, demotes repair priority and promotes upgrade+install to rebalance revenue mix.

### `config/conversion.json` — Revenue Model

```json
{
  "callCloseRate": 0.42,
  "formCloseRate": 0.18,
  "avgTicketCall": 485,
  "avgTicketForm": 2800,
  "targetCPL": 75
}
```

### `config/mode.json` — Operating Mode

CONSERVATIVE mode requires CPL < 80% of target before scaling, triggers pullback at 100%. Scale requires ALL conditions met; pullback triggers on ANY single condition.

### `config/capacity.json` — Team Capacity

```json
{
  "maxBacklogHours": 72,
  "techCapacity": 4,
  "currentBacklogHours": 0
}
```

---

## Feature Summary (v1.0 through v1.8)

| Version | Feature | Key Files |
|---------|---------|-----------|
| 1.0 | Core planner, report, validators, bundle assembler | `planner.ts`, `report.ts` |
| 1.1 | Metric snapshots, KPI tracking | `core/metrics/` |
| 1.2 | Experiment framework | `core/experiments.ts` |
| 1.3 | Conversion scoring, profit model | `core/metrics/conversionScoring.ts` |
| 1.4 | Geo priority engine, efficiency guard | `core/geo/geoPriorityEngine.ts` |
| 1.5 | Lead quality scoring, outcome calibration, season gate, waste hunter | `core/leads/`, `core/calibration/`, `core/seasonality/`, `core/ads/` |
| 1.6 | Conservative mode, tier expansion controls | `core/mode/conservativeGuard.ts` |
| 1.7 | Flow governor v1.0 (hard caps) | `core/flow/flowGovernor.ts` |
| 1.7.1 | Flow governor v1.1 (soft caps, quality discount, install ladder, repair share) | `core/flow/flowGovernor.ts` |
| **1.8** | **Geo weight learner (performance-based ZIP learning, approval-gated)** | **`core/geo/geoWeightLearner.ts`** |

---

## Integration with Marketing Operator

The Marketing Operator reads these files from this repo to generate content:

| File Read by Marketing Operator | What It Provides |
|------|------|
| `config/flow_state.json` | Current lead counts, backlog hours |
| `config/flow_control.json` | Caps and thresholds |
| `config/geo_priority.json` | 42 target ZIPs and weights |
| `metrics/snapshots/*.json` | Top pages, queries, conversions |

**Both repos must be sibling directories:**

```
your-project/
├── mbs-master-orchestrator/   <-- this repo
└── mbs-marketing-operator/    <-- reads from above
```

The marketing operator automatically finds the orchestrator via `../mbs-master-orchestrator/`. No configuration needed.

---

## Geo Weight Learner

The learner runs during `report` and evaluates each ZIP:

**Increase weight (+0.05, max 1.40) if ALL true:**
- Leads >= 5 (minimum data)
- CPL <= targetCPL x 0.90
- Profit efficiency > 0

**Decrease weight (-0.05, min 0.80) if ANY true:**
- CPL >= targetCPL x 1.15
- Profit efficiency < 0

**Outputs:**
- `bundles/week-N/geo/zip_weight_updates.json` — structured proposals
- `bundles/week-N/geo/zip_weight_updates.md` — human-readable summary
- `config/learned.json` → `geo.zipWeightsProposed` (status: `pending_approval`)

Weights never auto-apply. Review proposals, then manually update `config/geo_priority.json`.

---

## Tests

**519 tests across 86 suites, all passing.**

```bash
npx tsx scripts/run-tests.ts
```

---

## Deployment Checklist

1. Extract tarball on your Mac mini
2. `npm install` (only needs `tsx` and `typescript` — zero runtime deps)
3. Place real data CSVs in `metrics/import/`
4. Update `config/flow_state.json` with today's lead counts
5. `npx tsx cli/index.ts metrics --import`
6. `npx tsx cli/index.ts plan` — review intents
7. `npx tsx cli/index.ts report` — review dashboard in `bundles/`
8. Review `config/learned.json` for pending geo weight proposals
9. Set up cron schedule (see `docs/OPENCLAW_SCHEDULING.md`)
10. `git init && git add . && git commit -m "v1.8.0"`
