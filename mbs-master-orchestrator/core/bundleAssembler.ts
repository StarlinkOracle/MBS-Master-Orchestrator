import { resolve, join, basename } from "path";
import { existsSync, readdirSync, cpSync, readFileSync } from "fs";
import type {
  BundleManifest, BundleChecks, BundleCheckResult,
  OperatorConfig, ApprovalsSummary, ToolEnvelope, KPITargets, Experiment
} from "../types/index.js";
import {
  readJSON, writeJSON, writeText, ensureDir, deterministicHash,
  nowISO, todayISO, currentWeekNumber, findFiles, safeReadJSON,
  GENERATOR_VERSION, SCHEMA_VERSION
} from "../utils/index.js";
import { scanApprovals } from "./approvals.js";
import { generateBundleDiff } from "./diff.js";
import { generateWeeklyExperiments, saveExperiments } from "./experiments.js";
import { loadLatestSnapshot } from "./metrics/index.js";

const ROOT = process.cwd();

function loadOperators(): OperatorConfig[] {
  return readJSON<{ operators: OperatorConfig[] }>(resolve(ROOT, "config/orchestrator.json")).operators.filter((o) => o.enabled);
}

function loadKPIs(): KPITargets {
  return safeReadJSON<KPITargets>(resolve(ROOT, "config/kpi_targets.json"), {} as KPITargets);
}

export function assembleBundle(
  weekNumber?: number,
  intent?: string
): ToolEnvelope<{ bundleDir: string; manifest: BundleManifest; checks: BundleChecks }> {
  const week = weekNumber || currentWeekNumber();
  const date = todayISO();
  const bundleId = `bundle-${date}-week-${week}${intent ? `-${intent}` : ""}`;
  const bundleDir = resolve(ROOT, "bundles", date, `week-${week}`);

  ensureDir(bundleDir);
  ensureDir(join(bundleDir, "operators"));

  const operators = loadOperators();
  const kpi = loadKPIs();
  const approvalResult = scanApprovals();
  const approvalsSummary = approvalResult.data;

  // ---- Collect operator packs ----
  const operatorEntries: BundleManifest["operators"] = [];

  for (const op of operators) {
    const repoPath = resolve(ROOT, op.repoPath);
    const packsDir = resolve(repoPath, op.packGlob || "packs");

    if (!existsSync(packsDir)) {
      operatorEntries.push({
        name: op.name,
        packIds: [],
        packPaths: [],
        checksOverall: { passed: false, score: 0 },
        approvalStatus: "pending",
      });
      continue;
    }

    // Find today's packs (or most recent)
    const dateDirs = readdirSync(packsDir)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();

    const packIds: string[] = [];
    const packPaths: string[] = [];
    let totalScore = 0;
    let totalPassed = true;
    let packCount = 0;
    let approvalStatus: "pending" | "approved" | "rejected" = "pending";

    // Collect packs from most recent date directory
    const targetDate = dateDirs[0];
    if (targetDate) {
      const dateDir = resolve(packsDir, targetDate);
      const intentDirs = readdirSync(dateDir).filter((f) => {
        try { return readdirSync(resolve(dateDir, f)).length > 0; } catch { return false; }
      });

      for (const intentDir of intentDirs) {
        const packDir = resolve(dateDir, intentDir);
        const manifestPath = resolve(packDir, "pack_manifest.json");
        const checksPath = resolve(packDir, "checks.json");
        const approvalPath = resolve(packDir, "approval.json");

        if (existsSync(manifestPath)) {
          const manifest = readJSON<any>(manifestPath);
          packIds.push(manifest.packId || intentDir);
        } else {
          packIds.push(intentDir);
        }
        packPaths.push(packDir);

        if (existsSync(checksPath)) {
          const checks = readJSON<any>(checksPath);
          totalScore += checks.overallScore || 0;
          if (!checks.overallPassed) totalPassed = false;
          packCount++;
        }

        if (existsSync(approvalPath)) {
          const approval = readJSON<any>(approvalPath);
          if (approval.overallStatus === "approved") approvalStatus = "approved";
          else if (approval.overallStatus === "rejected") approvalStatus = "rejected";
        }

        // Copy pack artifacts to bundle
        const destDir = resolve(bundleDir, "operators", op.name, intentDir);
        ensureDir(destDir);
        try {
          cpSync(packDir, destDir, { recursive: true });
        } catch { /* best effort copy */ }
      }
    }

    operatorEntries.push({
      name: op.name,
      packIds,
      packPaths,
      checksOverall: {
        passed: totalPassed,
        score: packCount > 0 ? Math.round(totalScore / packCount) : 0,
      },
      approvalStatus,
    });
  }

  // ---- Bundle validation ----
  const bundleValidations: Record<string, BundleCheckResult> = {};

  // Check: all operators have packs
  const missingPacks = operatorEntries.filter((o) => o.packIds.length === 0);
  bundleValidations["operators_complete"] = {
    passed: missingPacks.length === 0,
    score: missingPacks.length === 0 ? 100 : Math.round(((operatorEntries.length - missingPacks.length) / operatorEntries.length) * 100),
    issues: missingPacks.map((o) => ({
      code: "BUNDLE_OPERATOR_MISSING_PACKS",
      severity: "warning" as const,
      message: `Operator "${o.name}" has no packs in current date`,
      suggestion: "Run operator plan/draft commands first",
    })),
  };

  // Check: all packs have manifests
  const manifestIssues: BundleCheckResult["issues"] = [];
  for (const op of operatorEntries) {
    for (const packPath of op.packPaths) {
      if (!existsSync(resolve(packPath, "pack_manifest.json"))) {
        manifestIssues.push({
          code: "PACK_MANIFEST_MISSING",
          severity: "error",
          message: `Pack at ${packPath} missing pack_manifest.json`,
        });
      }
    }
  }
  bundleValidations["pack_manifests"] = {
    passed: manifestIssues.length === 0,
    score: manifestIssues.length === 0 ? 100 : 0,
    issues: manifestIssues,
  };

  // Check: approval status
  const unapproved = operatorEntries.filter((o) => o.approvalStatus !== "approved" && o.packIds.length > 0);
  bundleValidations["approvals"] = {
    passed: unapproved.length === 0,
    score: unapproved.length === 0 ? 100 : Math.round(((operatorEntries.length - unapproved.length) / operatorEntries.length) * 100),
    issues: unapproved.map((o) => ({
      code: "APPROVAL_NOT_GRANTED",
      severity: "warning" as const,
      message: `Operator "${o.name}" packs not fully approved (status: ${o.approvalStatus})`,
      suggestion: "Run approval workflow before publishing",
    })),
  };

  const checks: BundleChecks = {
    bundleId,
    timestamp: nowISO(),
    validators: bundleValidations,
    overallPassed: Object.values(bundleValidations).every((v) => v.passed),
    overallScore: Math.round(
      Object.values(bundleValidations).reduce((s, v) => s + v.score, 0) / Object.keys(bundleValidations).length
    ),
  };

  writeJSON(join(bundleDir, "bundle_checks.json"), checks);

  // ---- Approvals summary ----
  if (approvalsSummary) {
    writeJSON(join(bundleDir, "approvals_summary.json"), approvalsSummary);
  }

  // ---- Generate experiments for this week ----
  let experiments: Experiment[] = [];
  const expResult = generateWeeklyExperiments(week);
  if (expResult.status === "EXECUTED" && expResult.data) {
    experiments = expResult.data;
    saveExperiments(bundleDir, experiments);
  }

  // ---- Copy latest metric snapshot into bundle ----
  const snapshot = loadLatestSnapshot();
  if (snapshot) {
    writeJSON(join(bundleDir, "metric_snapshot.json"), snapshot);
  }

  // ---- Deterministic hash ----
  const hashInput = JSON.stringify({ operators: operatorEntries, checks, kpi, experiments: experiments.map(e => e.id) });
  const dHash = deterministicHash(hashInput);

  // ---- Bundle manifest ----
  const manifest: BundleManifest = {
    bundleId,
    weekNumber: week,
    createdAt: nowISO(),
    deterministicHash: dHash,
    generatorVersion: GENERATOR_VERSION,
    schemaVersion: SCHEMA_VERSION,
    operators: operatorEntries,
    kpiSnapshot: kpi,
    experiments,
    requiresApproval: true,
  };

  writeJSON(join(bundleDir, "bundle_manifest.json"), manifest);

  // ---- Diff ----
  const diff = generateBundleDiff(bundleId, manifest, checks);
  writeText(join(bundleDir, "bundle_diff.md"), diff);

  // ---- Publish checklist ----
  const checklist = generatePublishChecklist(manifest, checks, approvalsSummary);
  writeText(join(bundleDir, "publish_checklist.md"), checklist);

  return { status: "EXECUTED", data: { bundleDir, manifest, checks } };
}

function generatePublishChecklist(
  manifest: BundleManifest,
  checks: BundleChecks,
  approvals?: ApprovalsSummary | null
): string {
  const lines: string[] = [
    "# Master Publish Checklist",
    "",
    `**Bundle ID:** ${manifest.bundleId}`,
    `**Week:** ${manifest.weekNumber}`,
    `**Generated:** ${manifest.createdAt}`,
    `**Hash:** ${manifest.deterministicHash.slice(0, 24)}...`,
    `**Bundle Validation:** ${checks.overallPassed ? "PASSED ✅" : "FAILED ❌"} (Score: ${checks.overallScore}/100)`,
    "",
    "---",
    "",
    "## Pre-Publish Gate",
    "",
  ];

  if (approvals && !approvals.allApproved) {
    lines.push("### ⛔ BLOCKED — Approvals Required", "");
    for (const reason of approvals.blockedReasons) {
      lines.push(`- **[${reason.operator}/${reason.packId}]** ${reason.reason}`);
    }
    lines.push("", "Resolve all approval issues before proceeding.", "");
  } else {
    lines.push("### ✅ All Approvals Granted", "");
  }

  lines.push("## Operator Publish Steps", "");

  for (const op of manifest.operators) {
    const icon = op.approvalStatus === "approved" ? "✅" : op.approvalStatus === "rejected" ? "❌" : "⏳";
    lines.push(`### ${icon} ${op.name}`, "");
    lines.push(`- Packs: ${op.packIds.length}`);
    lines.push(`- Validation: ${op.checksOverall.passed ? "passed" : "FAILED"} (${op.checksOverall.score}/100)`);
    lines.push(`- Approval: ${op.approvalStatus}`);
    lines.push("");

    if (op.packIds.length > 0) {
      lines.push("Pack IDs:");
      for (const pid of op.packIds) {
        lines.push(`  - [ ] ${pid}`);
      }
      lines.push("");
      lines.push("Steps:");
      lines.push("  - [ ] Review operator pack contents");
      lines.push("  - [ ] Verify validation results");
      lines.push("  - [ ] Follow operator-specific publish_checklist.md");
      lines.push("  - [ ] Mark as published in tracking system");
      lines.push("");
    } else {
      lines.push("  _(No packs to publish)_", "");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("**IMPORTANT:** No publish actions are permitted unless all approvals are granted.");
  lines.push("The orchestrator enforces this gate — no hidden overrides.");

  return lines.join("\n");
}
