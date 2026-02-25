/**
 * MBS Master Orchestrator — Demo Run
 *
 * Assumes mbs-marketing-operator exists at ../mbs-marketing-operator
 * (relative to this repo's root).
 *
 * Steps:
 * 1. marketing plan --days 30
 * 2. marketing draft --intent week-2-denver-ads-creative --type geo
 * 3. marketing draft --intent week-2-denver-ads-creative --type gbp
 * 4. marketing draft --intent week-2-denver-ads-creative --type google-ad
 * 5. marketing validate (on generated pack)
 * 6. marketing report --weekly
 * 7. Assemble master bundle
 * 8. Generate master report
 * 9. Show status
 */

import { runOperatorCommand } from "../core/operatorRunner.js";
import { assembleBundle } from "../core/bundleAssembler.js";
import { generateWeeklyReport, formatReportMarkdown } from "../core/report.js";
import { generateWeeklyPlan } from "../core/planner.js";
import { scanApprovals, isPublishAllowed } from "../core/approvals.js";
import { writeJSON, writeText, ensureDir, currentWeekNumber, todayISO } from "../utils/index.js";
import { join, resolve } from "path";
import { existsSync } from "fs";
import type { OperatorExecResult } from "../types/index.js";

const ROOT = process.cwd();
const INTENT = "week-2-denver-ads-creative";

function logStep(n: number, label: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(` Step ${n}: ${label}`);
  console.log(`${"=".repeat(60)}\n`);
}

function logResult(result: { status: string; data?: OperatorExecResult; error?: any }) {
  if (result.status === "EXECUTED" && result.data) {
    console.log(`  ✅ Success (${result.data.durationMs}ms)`);
    const lines = result.data.stdout.split("\n").filter(Boolean);
    for (const line of lines.slice(0, 15)) console.log(`  ${line}`);
    if (lines.length > 15) console.log(`  ... (${lines.length - 15} more lines)`);
  } else {
    console.log(`  ❌ ${result.status}: ${result.error?.message || "unknown error"}`);
    if (result.data?.stderr) {
      const errLines = result.data.stderr.split("\n").slice(0, 5);
      for (const line of errLines) console.log(`  ERR: ${line}`);
    }
  }
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║   MBS Master Orchestrator — Demo Run                     ║");
  console.log("╠════════════════════════════════════════════════════════════╣");
  console.log("║   Orchestrating: mbs-marketing-operator                  ║");
  console.log("║   Intent: week-2-denver-ads-creative                     ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  // Check operator exists
  const marketingPath = resolve(ROOT, "../mbs-marketing-operator");
  if (!existsSync(marketingPath)) {
    console.error(`\n❌ Marketing operator not found at: ${marketingPath}`);
    console.error("   Make sure mbs-marketing-operator is in the sibling directory.");
    process.exit(1);
  }
  console.log(`\n✅ Marketing operator found: ${marketingPath}`);

  // Step 0: Generate weekly plan
  logStep(0, "Generate KPI-driven Weekly Plan");
  const planResult = generateWeeklyPlan();
  if (planResult.data) {
    console.log(`  Plan ID: ${planResult.data.planId}`);
    console.log(`  Week: ${planResult.data.weekNumber}`);
    console.log(`  Intents: ${planResult.data.intents.length}`);
    for (const intent of planResult.data.intents.slice(0, 5)) {
      console.log(`    [${intent.priority.toUpperCase()}] ${intent.operator}: ${intent.command} → ${intent.reason}`);
    }
    if (planResult.data.intents.length > 5) console.log(`    ... and ${planResult.data.intents.length - 5} more`);
    ensureDir(join(ROOT, "bundles"));
    writeJSON(join(ROOT, "bundles", `plan-w${planResult.data.weekNumber}.json`), planResult.data);
  }

  // Step 1: marketing plan
  logStep(1, "Marketing: Generate 30-day Plan");
  logResult(runOperatorCommand("marketing", "plan", ["--days", "30"]));

  // Step 2: marketing draft GEO page
  logStep(2, "Marketing: Draft GEO Page (Arvada, Furnace Installation)");
  logResult(runOperatorCommand("marketing", "draft", [
    "--intent", INTENT, "--type", "geo", "--city", "Arvada", "--service", "Furnace Installation"
  ]));

  // Step 3: marketing draft GBP post
  logStep(3, "Marketing: Draft GBP Post");
  logResult(runOperatorCommand("marketing", "draft", [
    "--intent", INTENT, "--type", "gbp", "--service", "Furnace Repair"
  ]));

  // Step 4: marketing draft Google Ad
  logStep(4, "Marketing: Draft Google Ads Campaign");
  logResult(runOperatorCommand("marketing", "draft", [
    "--intent", INTENT, "--type", "google-ad", "--service", "Furnace Repair", "--city", "Denver"
  ]));

  // Step 5: marketing draft Meta Ad
  logStep(5, "Marketing: Draft Meta Retargeting Campaign");
  logResult(runOperatorCommand("marketing", "draft", [
    "--intent", INTENT, "--type", "meta-ad", "--service", "Furnace Installation"
  ]));

  // Step 6: marketing report
  logStep(6, "Marketing: Weekly Report");
  logResult(runOperatorCommand("marketing", "report", ["--weekly"]));

  // Step 7: Scan approvals
  logStep(7, "Scan Operator Approvals");
  const appResult = scanApprovals();
  if (appResult.data) {
    console.log(`  All approved: ${appResult.data.allApproved}`);
    for (const op of appResult.data.operators) {
      console.log(`  ${op.name}: ${op.packs.length} pack(s)`);
      for (const p of op.packs) {
        console.log(`    - ${p.packId}: ${p.overallStatus} (${p.approved}/${p.totalItems} approved)`);
      }
    }
    if (appResult.data.blockedReasons.length > 0) {
      console.log(`\n  Blocked reasons:`);
      for (const r of appResult.data.blockedReasons) console.log(`    ⛔ [${r.operator}/${r.packId}] ${r.reason}`);
    }

    const publish = isPublishAllowed();
    console.log(`\n  Publish gate: ${publish.allowed ? "✅ OPEN" : "⛔ BLOCKED"}`);
  }

  // Step 8: Assemble bundle
  logStep(8, "Assemble Master Bundle");
  const bundleResult = assembleBundle();
  if (bundleResult.status === "EXECUTED" && bundleResult.data) {
    const { bundleDir, manifest, checks } = bundleResult.data;
    console.log(`  Bundle ID: ${manifest.bundleId}`);
    console.log(`  Hash: ${manifest.deterministicHash.slice(0, 24)}...`);
    console.log(`  Validation: ${checks.overallPassed ? "PASSED ✅" : "FAILED ❌"} (${checks.overallScore}/100)`);
    for (const op of manifest.operators) {
      console.log(`  ${op.name}: ${op.packIds.length} packs, ${op.approvalStatus}`);
    }
    console.log(`  Bundle dir: ${bundleDir}`);
  }

  // Step 9: Generate master report
  logStep(9, "Generate Master Report");
  const reportResult = generateWeeklyReport();
  if (reportResult.data) {
    const md = formatReportMarkdown(reportResult.data);
    const outDir = join(ROOT, "bundles");
    writeText(join(outDir, `master_report-w${reportResult.data.weekNumber}.md`), md);
    writeJSON(join(outDir, `report-w${reportResult.data.weekNumber}.json`), reportResult.data);
    console.log(md);
  }

  // Final summary
  console.log("\n" + "═".repeat(60));
  console.log(" DEMO COMPLETE");
  console.log("═".repeat(60));
  console.log(`
Next steps:
  1. Review bundle:       tsx cli/index.ts status
  2. Approve packs:       tsx cli/index.ts approve --operator marketing --pack <path> --item all
  3. Validate bundle:     tsx cli/index.ts validate --bundle bundles/${todayISO()}/week-${currentWeekNumber()}
  4. Check publish gate:  tsx cli/index.ts status
`);
}

main().catch(console.error);
