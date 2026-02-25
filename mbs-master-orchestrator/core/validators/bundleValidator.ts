import { resolve, join } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import type { BundleChecks, BundleCheckResult, BundleManifest, ToolEnvelope } from "../../types/index.js";
import { readJSON, safeReadJSON, nowISO, deterministicHash, SCHEMA_VERSION } from "../../utils/index.js";
import { computePackContentHash } from "../approvals.js";

export function validateBundle(bundlePath: string): ToolEnvelope<BundleChecks> {
  if (!existsSync(bundlePath)) {
    return { status: "FAILED", error: { code: "BUNDLE_NOT_FOUND", message: `Bundle path not found: ${bundlePath}` } };
  }

  const validators: Record<string, BundleCheckResult> = {};
  const manifestPath = join(bundlePath, "bundle_manifest.json");

  // 1) Manifest exists and valid
  if (!existsSync(manifestPath)) {
    validators["manifest_exists"] = {
      passed: false, score: 0,
      issues: [{ code: "BUNDLE_MANIFEST_MISSING", severity: "error", message: "bundle_manifest.json not found" }],
    };
  } else {
    const manifest = safeReadJSON<BundleManifest>(manifestPath, null as any);
    const issues: BundleCheckResult["issues"] = [];

    if (!manifest) {
      issues.push({ code: "BUNDLE_MANIFEST_INVALID", severity: "error", message: "Failed to parse bundle_manifest.json" });
    } else {
      if (!manifest.bundleId) issues.push({ code: "BUNDLE_MANIFEST_FIELD", severity: "error", message: "Missing bundleId" });
      if (!manifest.deterministicHash) issues.push({ code: "BUNDLE_MANIFEST_FIELD", severity: "error", message: "Missing deterministicHash" });
      if (manifest.schemaVersion !== SCHEMA_VERSION) {
        issues.push({ code: "BUNDLE_SCHEMA_MISMATCH", severity: "warning", message: `Schema ${manifest.schemaVersion} != expected ${SCHEMA_VERSION}` });
      }
    }

    validators["manifest_valid"] = {
      passed: issues.filter((i) => i.severity === "error").length === 0,
      score: issues.length === 0 ? 100 : 50,
      issues,
    };
  }

  // 2) Required files exist
  const requiredFiles = ["bundle_manifest.json", "bundle_checks.json", "bundle_diff.md", "publish_checklist.md", "approvals_summary.json"];
  const missingFiles = requiredFiles.filter((f) => !existsSync(join(bundlePath, f)));
  validators["required_files"] = {
    passed: missingFiles.length === 0,
    score: Math.round(((requiredFiles.length - missingFiles.length) / requiredFiles.length) * 100),
    issues: missingFiles.map((f) => ({ code: "BUNDLE_FILE_MISSING", severity: "warning" as const, message: `Missing: ${f}` })),
  };

  // 3) Operators directory exists with content
  const operatorsDir = join(bundlePath, "operators");
  if (!existsSync(operatorsDir)) {
    validators["operators_present"] = {
      passed: false, score: 0,
      issues: [{ code: "BUNDLE_OPERATORS_MISSING", severity: "error", message: "operators/ directory not found" }],
    };
  } else {
    const operatorDirs = readdirSync(operatorsDir);
    validators["operators_present"] = {
      passed: operatorDirs.length > 0,
      score: operatorDirs.length > 0 ? 100 : 0,
      issues: operatorDirs.length === 0
        ? [{ code: "BUNDLE_OPERATORS_EMPTY", severity: "warning", message: "operators/ directory is empty" }]
        : [],
    };
  }

  // 4) Approval summary check
  const approvalsSummaryPath = join(bundlePath, "approvals_summary.json");
  if (existsSync(approvalsSummaryPath)) {
    const summary = safeReadJSON<any>(approvalsSummaryPath, { allApproved: false });
    validators["approvals_cleared"] = {
      passed: summary.allApproved === true,
      score: summary.allApproved ? 100 : 0,
      issues: summary.allApproved
        ? []
        : [{ code: "BUNDLE_APPROVALS_PENDING", severity: "warning", message: "Not all operator packs approved" }],
    };
  }

  // 5) Approval integrity — check that approved packs haven't been modified
  if (existsSync(operatorsDir)) {
    const integrityIssues: BundleCheckResult["issues"] = [];
    for (const opName of readdirSync(operatorsDir)) {
      const opDir = join(operatorsDir, opName);
      try {
        for (const intentDir of readdirSync(opDir)) {
          const packDir = join(opDir, intentDir);
          const approvalPath = join(packDir, "approval.json");
          if (!existsSync(approvalPath)) continue;

          const approval = safeReadJSON<any>(approvalPath, null);
          if (!approval || approval.overallStatus !== "approved") continue;

          const storedHash = approval.contentHashAtApproval;
          if (!storedHash) {
            integrityIssues.push({
              code: "APPROVAL_HASH_MISSING",
              severity: "info",
              message: `${opName}/${intentDir}: no contentHashAtApproval recorded — integrity unchecked`,
              suggestion: "Re-approve via orchestrator to record content hash",
            });
            continue;
          }

          const currentHash = computePackContentHash(packDir);
          if (currentHash !== storedHash) {
            integrityIssues.push({
              code: "APPROVAL_HASH_INVALID",
              severity: "error",
              message: `${opName}/${intentDir}: pack content changed after approval (hash mismatch)`,
              suggestion: "Pack must be re-approved — approval is invalidated",
            });
          }
        }
      } catch { /* skip non-directories */ }
    }

    const errorCount = integrityIssues.filter((i) => i.severity === "error").length;
    validators["approval_integrity"] = {
      passed: errorCount === 0,
      score: errorCount === 0 ? 100 : 0,
      issues: integrityIssues,
    };
  }

  const overallPassed = Object.values(validators).every((v) => v.passed);
  const vals = Object.values(validators);
  const overallScore = vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v.score, 0) / vals.length) : 0;

  const checks: BundleChecks = {
    bundleId: safeReadJSON<any>(manifestPath, { bundleId: "unknown" }).bundleId,
    timestamp: nowISO(),
    validators,
    overallPassed,
    overallScore,
  };

  return { status: "EXECUTED", data: checks };
}
