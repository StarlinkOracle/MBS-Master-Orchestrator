# OpenClaw Scheduling — Mac Mini Runbook

> Safe cron-based scheduling for the MBS Master Orchestrator on a Mac mini.

---

## Principles

1. **All commands are idempotent** — rerunning on the same day with same inputs produces same outputs.
2. **No auto-publish** — scheduled tasks produce drafts and bundles that require manual approval.
3. **Timeouts enforced** — each operator command has a configurable timeout (default: 120s).
4. **Logs captured** — redirect stdout/stderr to log files for review.

---

## Recommended Cron Schedule

```bash
# Edit crontab
crontab -e

# ============================================================
# MBS Master Orchestrator — Weekly Schedule
# ============================================================

# Monday 7:00 AM — Generate weekly plan
0 7 * * 1 cd /path/to/mbs-master-orchestrator && tsx cli/index.ts plan --week current >> logs/plan.log 2>&1

# Monday 7:30 AM — Run planned marketing intents
30 7 * * 1 cd /path/to/mbs-master-orchestrator && tsx cli/index.ts run --operator marketing --command plan --days 30 >> logs/run.log 2>&1

# Monday 8:00 AM — Draft weekly content batch
0 8 * * 1 cd /path/to/mbs-master-orchestrator && tsx cli/index.ts run --operator marketing --command draft --intent weekly-auto --type geo >> logs/draft.log 2>&1

# Wednesday 8:00 AM — GBP post draft
0 8 * * 3 cd /path/to/mbs-master-orchestrator && tsx cli/index.ts run --operator marketing --command draft --intent midweek-gbp --type gbp >> logs/gbp.log 2>&1

# Friday 9:00 AM — Assemble weekly bundle
0 9 * * 5 cd /path/to/mbs-master-orchestrator && tsx cli/index.ts bundle >> logs/bundle.log 2>&1

# Friday 9:30 AM — Generate weekly report
30 9 * * 5 cd /path/to/mbs-master-orchestrator && tsx cli/index.ts report --weekly >> logs/report.log 2>&1

# Friday 10:00 AM — Show status (for review)
0 10 * * 5 cd /path/to/mbs-master-orchestrator && tsx cli/index.ts status >> logs/status.log 2>&1
```

---

## Log Management

```bash
# Create log directory
mkdir -p /path/to/mbs-master-orchestrator/logs

# Rotate logs (add to crontab, Sunday midnight)
0 0 * * 0 cd /path/to/mbs-master-orchestrator && find logs/ -name "*.log" -mtime +30 -delete
```

---

## Manual Workflow

For operators who prefer manual control:

```bash
# 1. Plan the week
tsx cli/index.ts plan --week current

# 2. Review plan, then run specific intents
tsx cli/index.ts run --operator marketing --command draft --intent week-9-geo --type geo --city Denver

# 3. Check status
tsx cli/index.ts status

# 4. Approve when ready
tsx cli/index.ts approve --operator marketing --pack ../mbs-marketing-operator/packs/2026-02-24/week-9-geo --item all

# 5. Bundle and validate
tsx cli/index.ts bundle
tsx cli/index.ts validate --bundle bundles/2026-02-24/week-9

# 6. Generate report
tsx cli/index.ts report --weekly
```

---

## Safety Rules

1. **Never schedule `approve` commands** — approvals are always manual.
2. **Never schedule `export` commands** — exports require an approved bundle.
3. **Review logs daily** — check for failed commands or timeout errors.
4. **Keep operator repos updated** — `git pull` before scheduled runs if using remote repos.
5. **Monitor disk space** — bundles accumulate; configure `bundleRetentionDays` in orchestrator.json.
