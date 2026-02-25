import { resolve } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import type { OperatorApprovalFile, ApprovalsSummary, ToolEnvelope, OperatorConfig } from "../types/index.js";
import { readJSON, findFiles, nowISO, safeReadJSON, hashFile, deterministicHash } from "../utils/index.js";

const ROOT = process.cwd();

function loadOperators(): OperatorConfig[] {
  return readJSON<{ operators: OperatorConfig[] }>(resolve(ROOT, "config/orchestrator.json")).operators;
}

/**
 * Compute a content hash for a pack by hashing all content + ads JSON files.
 * This is what we compare against after approval to detect post-approval changes.
 */
function computePackContentHash(packPath: string): string {
  const parts: string[] = [];
  for (const subdir of ["content", "ads"]) {
    const dir = resolve(packPath, subdir);
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
      for (const f of files) {
        parts.push(f + ":" + readFileSync(resolve(dir, f), "utf-8"));
      }
    } catch { /* skip */ }
  }
  return deterministicHash(parts.join("|"));
}

/**
 * Check whether pack content changed since approval was granted.
 * We store the content hash at approval time inside approval.json (contentHashAtApproval).
 * If missing, we return "unchecked".
 */
function checkHashIntegrity(packPath: string, approval: OperatorApprovalFile): "valid" | "invalid" | "unchecked" {
  // approval.json may carry a contentHashAtApproval field (set by orchestrator)
  const storedHash = (approval as any).contentHashAtApproval;
  if (!storedHash) return "unchecked";

  const currentHash = computePackContentHash(packPath);
  return currentHash === storedHash ? "valid" : "invalid";
}

export function scanApprovals(): ToolEnvelope<ApprovalsSummary> {
  const operators = loadOperators().filter((o) => o.enabled);
  const summary: ApprovalsSummary = {
    timestamp: nowISO(),
    operators: [],
    blockedReasons: [],
    allApproved: true,
  };

  for (const op of operators) {
    const repoPath = resolve(ROOT, op.repoPath);
    if (!existsSync(repoPath)) {
      summary.blockedReasons.push({
        operator: op.name,
        packId: "*",
        reason: `Operator repo not found: ${repoPath}`,
      });
      summary.allApproved = false;
      continue;
    }

    const packsDir = resolve(repoPath, op.packGlob || "packs");
    const approvalFiles = findFiles(packsDir, "approval.json");

    const operatorEntry: ApprovalsSummary["operators"][0] = { name: op.name, packs: [] };

    for (const approvalPath of approvalFiles) {
      const approval = safeReadJSON<OperatorApprovalFile>(approvalPath, null as any);
      if (!approval) continue;

      const packPath = resolve(approvalPath, "..");
      const approved = approval.items.filter((i) => i.status === "approved").length;
      const pending = approval.items.filter((i) => i.status === "pending").length;
      const rejected = approval.items.filter((i) => i.status === "rejected").length;

      // Hash integrity check
      const integrity = checkHashIntegrity(packPath, approval);

      operatorEntry.packs.push({
        packId: approval.packId,
        packPath,
        overallStatus: approval.overallStatus,
        totalItems: approval.items.length,
        approved,
        pending,
        rejected,
        hashIntegrity: integrity,
      });

      if (approval.overallStatus !== "approved") {
        summary.allApproved = false;
        if (approval.overallStatus === "pending") {
          summary.blockedReasons.push({
            operator: op.name,
            packId: approval.packId,
            reason: `${pending} item(s) still pending approval`,
          });
        } else if (approval.overallStatus === "rejected") {
          summary.blockedReasons.push({
            operator: op.name,
            packId: approval.packId,
            reason: `Pack rejected (${rejected} item(s) rejected)`,
          });
        }
      }

      // Integrity failure blocks publish even if approval says "approved"
      if (integrity === "invalid") {
        summary.allApproved = false;
        summary.blockedReasons.push({
          operator: op.name,
          packId: approval.packId,
          reason: "APPROVAL INVALIDATED: pack content hash changed after approval was granted",
        });
      }
    }

    if (approvalFiles.length === 0) {
      summary.blockedReasons.push({
        operator: op.name,
        packId: "*",
        reason: "No packs found — run operator plan/draft first",
      });
      summary.allApproved = false;
    }

    summary.operators.push(operatorEntry);
  }

  return { status: "EXECUTED", data: summary };
}

export function isPublishAllowed(): { allowed: boolean; reasons: string[] } {
  const result = scanApprovals();
  if (result.status !== "EXECUTED" || !result.data) {
    return { allowed: false, reasons: ["Failed to scan approvals"] };
  }
  return {
    allowed: result.data.allApproved,
    reasons: result.data.blockedReasons.map((r) => `[${r.operator}/${r.packId}] ${r.reason}`),
  };
}

// Exported for bundleValidator and tests
export { computePackContentHash };
