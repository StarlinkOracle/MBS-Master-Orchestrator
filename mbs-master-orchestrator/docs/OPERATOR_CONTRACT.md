# Operator Contract

> Requirements for any repo to be orchestrated by `mbs-master-orchestrator`.

---

## CLI Commands

Every operator MUST expose these CLI commands:

| Command | Description | Side Effects |
|---|---|---|
| `plan` | Generate a marketing/action plan | Writes plan file |
| `draft` | Produce content for a specific intent | Writes content files |
| `validate` | Run quality validators against packs | Writes checks.json |
| `approve` | Approve/reject pack items | Writes approval.json |
| `export` | Export approved pack to target dir | Copies files |
| `report` | Generate status/weekly report | Writes report files |
| `experiment` | Create/manage experiments | Writes experiment files |

### CLI Interface

The orchestrator calls operators via shell exec:

```bash
cd <operator-repo-path>
<cli-command> <command> [--flag value ...]
```

Example for marketing operator:
```bash
cd ../mbs-marketing-operator
tsx cli/index.ts draft --intent week-2 --type geo --city Denver
```

### Execution Guarantees

- Commands MUST be **idempotent** — running twice with same input produces same output
- Commands MUST NOT **auto-publish** — side effects limited to local file writes
- Commands MUST write **structured output** to stdout (parseable by orchestrator)
- Commands MUST return **exit code 0** on success, non-zero on failure
- Commands MUST complete within the configured **timeout** (default: 120s)

---

## Pack Format

Every operator MUST produce packs in this structure:

```
packs/YYYY-MM-DD/<intent>/
├── pack.json               # Summary
├── pack_manifest.json      # MBS integration contract
├── checks.json             # Validation results
├── approval.json           # Item-level approvals
├── diff.md                 # Changes vs previous
├── publish_checklist.md    # Manual publish steps
├── config_snapshot.json    # Frozen config
├── content/                # Content assets
├── ads/                    # Ad campaign configs
└── media/                  # Media assets
```

### Required Files

| File | Required | Purpose |
|---|---|---|
| pack_manifest.json | YES | MBS integration contract with deterministic hash |
| checks.json | YES | Validation results (passed/score/issues) |
| approval.json | YES | Approval state (pending/approved/rejected) |
| pack.json | Recommended | Summary and content index |
| publish_checklist.md | Recommended | Manual publish instructions |

### approval.json Format

```json
{
  "packId": "pack-2026-02-24-intent-name",
  "overallStatus": "pending" | "approved" | "rejected",
  "items": [
    {
      "itemId": "content:geo:city-slug",
      "type": "content",
      "description": "GEO page for City",
      "status": "pending" | "approved" | "rejected",
      "approvedBy": "operator",
      "approvedAt": "2026-02-24T..."
    }
  ],
  "createdAt": "...",
  "lastUpdated": "..."
}
```

### pack_manifest.json Format

```json
{
  "packId": "pack-2026-02-24-intent-name",
  "intent": "intent-name",
  "version": "1.0.0",
  "createdAt": "...",
  "deterministicHash": "sha256...",
  "generatorVersion": "1.0.0",
  "configHash": "sha256...",
  "requiresApproval": true,
  "schemaVersion": "1.0.0"
}
```

---

## Config Registration

Register operators in `config/orchestrator.json`:

```json
{
  "operators": [
    {
      "name": "marketing",
      "repoPath": "../mbs-marketing-operator",
      "cli": "tsx cli/index.ts",
      "intents": ["weekly", "daily"],
      "enabled": true,
      "timeoutSeconds": 120,
      "packGlob": "packs"
    }
  ]
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| name | string | Unique operator identifier |
| repoPath | string | Relative path from orchestrator root |
| cli | string | CLI command prefix |
| intents | string[] | Supported intent types |
| enabled | boolean | Whether orchestrator runs this operator |
| timeoutSeconds | number | Max execution time per command |
| packGlob | string | Directory name where packs live |

---

## Future Operators

Planned operators following this contract:
- `sales-operator` — CRM workflows, lead routing, proposal generation
- `ops-operator` — Scheduling, dispatch, inventory management
- `finance-operator` — Invoicing, revenue tracking, reporting
- `contracts-operator` — Service agreements, warranty tracking
