#!/usr/bin/env node

/**
 * MBS Master Orchestrator CLI
 * Zero external dependencies — Node.js built-ins + project modules only.
 */

import { generateWeeklyPlan } from "../core/planner.js";
import { runOperatorCommand } from "../core/operatorRunner.js";
import { assembleBundle } from "../core/bundleAssembler.js";
import { scanApprovals, isPublishAllowed } from "../core/approvals.js";
import { generateWeeklyReport, formatReportMarkdown } from "../core/report.js";
import { validateBundle } from "../core/validators/bundleValidator.js";
import { importMetrics, loadLatestSnapshot } from "../core/metrics/index.js";
import { generateWeeklyExperiments, saveExperiments } from "../core/experiments.js";
import { writeJSON, writeText, readJSON, ensureDir, currentWeekNumber, GENERATOR_VERSION } from "../utils/index.js";
import { join } from "path";
import { existsSync } from "fs";

// ---- Argv Parser ----
function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const args = argv.slice(2);
  const command = args[0] || "help";
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].replace(/^--/, "");
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true";
      flags[key] = val;
      if (val !== "true") i++;
    }
  }
  return { command, flags };
}

const { command, flags } = parseArgs(process.argv);

switch (command) {

  // ============================================================
  // plan
  // ============================================================
  case "plan": {
    const week = flags.week === "current" ? undefined : parseInt(flags.week || "0") || undefined;
    console.log(`\n📋 Generating weekly plan...\n`);

    const result = generateWeeklyPlan(week);
    if (result.status === "EXECUTED" && result.data) {
      const plan = result.data;
      const outPath = join(process.cwd(), "bundles", `plan-w${plan.weekNumber}.json`);
      ensureDir(join(process.cwd(), "bundles"));
      writeJSON(outPath, plan);

      console.log(`Plan ID: ${plan.planId}`);
      console.log(`Week: ${plan.weekNumber}`);
      console.log(`Intents: ${plan.intents.length}\n`);

      for (const intent of plan.intents) {
        const icon = intent.priority === "high" ? "🔴" : intent.priority === "medium" ? "🟡" : "🔵";
        console.log(`  ${icon} [${intent.priority.toUpperCase()}] ${intent.operator}: ${intent.command} ${intent.args.join(" ")}`);
        console.log(`     Reason: ${intent.reason}`);
        if (intent.kpiDriver) console.log(`     KPI: ${intent.kpiDriver}`);
        if (intent.expectedConversionValue != null) {
          console.log(`     Conv: ${intent.expectedCalls || 0} calls + ${intent.expectedForms || 0} forms = ${intent.expectedConversionValue} weighted`);
        }
        console.log("");
      }
      console.log(`Saved to: ${outPath}`);
    }
    break;
  }

  // ============================================================
  // run
  // ============================================================
  case "run": {
    const intent = flags.intent;
    const operator = flags.operator || "marketing";
    const cmd = flags.command || "draft";
    const extraArgs: string[] = [];

    if (intent) extraArgs.push("--intent", intent);
    if (flags.type) extraArgs.push("--type", flags.type);
    if (flags.city) extraArgs.push("--city", flags.city);
    if (flags.service) extraArgs.push("--service", flags.service);
    if (flags.days) extraArgs.push("--days", flags.days);
    if (flags.pack) extraArgs.push("--pack", flags.pack);

    console.log(`\n🚀 Running: ${operator} ${cmd} ${extraArgs.join(" ")}\n`);

    const result = runOperatorCommand(operator, cmd, extraArgs);
    if (result.status === "EXECUTED" && result.data) {
      console.log(`✅ Success (${result.data.durationMs}ms)\n`);
      console.log(result.data.stdout);
      if (result.data.stderr) console.log(`\n--- Stderr ---\n${result.data.stderr}`);
    } else {
      console.error(`❌ Failed: ${result.error?.message}`);
      if (result.data) {
        if (result.data.stdout) console.log(`\n${result.data.stdout}`);
        if (result.data.stderr) console.log(`\n--- Stderr ---\n${result.data.stderr}`);
      }
    }
    break;
  }

  // ============================================================
  // bundle
  // ============================================================
  case "bundle": {
    const week = flags.week ? parseInt(flags.week) : undefined;
    const intent = flags.intent;
    console.log(`\n📦 Assembling weekly bundle...\n`);

    const result = assembleBundle(week, intent);
    if (result.status === "EXECUTED" && result.data) {
      const { bundleDir, manifest, checks } = result.data;
      console.log(`Bundle ID: ${manifest.bundleId}`);
      console.log(`Week: ${manifest.weekNumber}`);
      console.log(`Hash: ${manifest.deterministicHash.slice(0, 24)}...`);
      console.log(`Validation: ${checks.overallPassed ? "PASSED ✅" : "FAILED ❌"} (${checks.overallScore}/100)\n`);

      for (const op of manifest.operators) {
        const icon = op.approvalStatus === "approved" ? "✅" : "⏳";
        console.log(`  ${icon} ${op.name}: ${op.packIds.length} packs, validation ${op.checksOverall.score}/100, approval: ${op.approvalStatus}`);
      }
      console.log(`\nBundle: ${bundleDir}`);
    } else {
      console.error("Bundle failed:", result.error);
    }
    break;
  }

  // ============================================================
  // report
  // ============================================================
  case "report": {
    const week = flags.week ? parseInt(flags.week) : undefined;
    console.log(`\n📊 Generating master weekly report...\n`);

    const result = generateWeeklyReport(week);
    if (result.status === "EXECUTED" && result.data) {
      const md = formatReportMarkdown(result.data);
      const outDir = join(process.cwd(), "bundles");
      ensureDir(outDir);
      writeJSON(join(outDir, `report-w${result.data.weekNumber}.json`), result.data);
      writeText(join(outDir, `master_report-w${result.data.weekNumber}.md`), md);
      console.log(md);
      console.log(`\nSaved to: ${outDir}`);
    }
    break;
  }

  // ============================================================
  // status
  // ============================================================
  case "status": {
    console.log(`\n📈 Orchestrator Status (v${GENERATOR_VERSION})\n`);

    // Overlay snapshot onto KPIs
    const kpiRaw = readJSON<any>(join(process.cwd(), "config/kpi_targets.json"));
    const snapshot = loadLatestSnapshot();
    if (snapshot?.indexedPages != null) {
      kpiRaw.indexedPages.current = snapshot.indexedPages;
    }

    console.log("KPI Dashboard:");
    for (const [key, val] of Object.entries(kpiRaw) as [string, any][]) {
      const pct = Math.min(100, Math.round((val.current / val.target) * 100));
      const filled = Math.round(pct / 5);
      console.log(`  ${key}: ${"█".repeat(filled)}${"░".repeat(20 - filled)} ${pct}% (${val.current}/${val.target})`);
    }
    if (snapshot) {
      console.log(`\n  Data: GSC ${snapshot.date} — ${snapshot.totals.impressions.toLocaleString()} impr, ${snapshot.totals.clicks.toLocaleString()} clicks, ${(snapshot.totals.ctr * 100).toFixed(1)}% CTR, pos ${snapshot.totals.avgPosition.toFixed(1)}`);
      if (snapshot.conversions) {
        console.log(`  Conversions: 📞 ${snapshot.conversions.CALL_CLICK || 0} calls | 📋 ${snapshot.conversions.FORM_SUBMIT || 0} forms | ⚖️ ${snapshot.conversions.weightedTotal?.toFixed(1) || "0"} weighted`);
      }
    } else {
      console.log(`\n  (No GSC snapshot — using static config. Run: mbs-master metrics --import)`);
    }

    console.log("\nApproval Status:");
    const appResult = scanApprovals();
    if (appResult.data) {
      for (const op of appResult.data.operators) {
        console.log(`  ${op.name}:`);
        if (op.packs.length === 0) console.log("    (no packs)");
        for (const pack of op.packs) {
          const icon = pack.overallStatus === "approved" ? "✅" : pack.overallStatus === "rejected" ? "❌" : "⏳";
          const integ = pack.hashIntegrity === "invalid" ? " 🔴 HASH INVALID" : pack.hashIntegrity === "valid" ? " 🟢 hash ok" : "";
          console.log(`    ${icon} ${pack.packId}: ${pack.approved}/${pack.totalItems} approved, ${pack.pending} pending${integ}`);
        }
      }

      if (appResult.data.blockedReasons.length > 0) {
        console.log("\n⛔ Blocked:");
        for (const r of appResult.data.blockedReasons) console.log(`  - [${r.operator}/${r.packId}] ${r.reason}`);
      }

      const publishCheck = isPublishAllowed();
      console.log(`\nPublish gate: ${publishCheck.allowed ? "✅ OPEN" : "⛔ BLOCKED"}`);
      if (!publishCheck.allowed) for (const r of publishCheck.reasons) console.log(`  - ${r}`);
    }
    break;
  }

  // ============================================================
  // approve
  // ============================================================
  case "approve": {
    const operator = flags.operator || "marketing";
    const packPath = flags.pack;
    const item = flags.item || "all";

    if (!packPath) { console.error("Usage: approve --operator <n> --pack <path> --item <id|all>"); process.exit(1); }

    console.log(`\n🔏 Proxying approval to ${operator}...\n`);
    const result = runOperatorCommand(operator, "approve", ["--pack", packPath, "--item", item]);
    if (result.status === "EXECUTED" && result.data) {
      console.log(result.data.stdout);
    } else {
      console.error("Failed:", result.error?.message);
      if (result.data) console.log(result.data.stderr);
    }
    break;
  }

  // ============================================================
  // validate
  // ============================================================
  case "validate": {
    const bundlePath = flags.bundle || flags.pack;
    if (!bundlePath) { console.error("Usage: validate --bundle <path>"); process.exit(1); }

    console.log(`\n🔍 Validating bundle: ${bundlePath}\n`);
    const result = validateBundle(bundlePath);
    if (result.data) {
      console.log(`Overall: ${result.data.overallPassed ? "PASSED ✅" : "FAILED ❌"} (${result.data.overallScore}/100)\n`);
      for (const [name, v] of Object.entries(result.data.validators)) {
        console.log(`  ${v.passed ? "✅" : "❌"} ${name}: ${v.score}/100`);
        for (const issue of v.issues) {
          const sev = issue.severity === "error" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
          console.log(`      ${sev} [${issue.code}] ${issue.message}`);
        }
      }
    }
    break;
  }

  // ============================================================
  // metrics — import CSVs and manage snapshots
  // ============================================================
  case "metrics": {
    const subcmd = flags.import ? "import" : flags.latest ? "latest" : flags.date ? "date" : "import";

    if (subcmd === "import" || flags.import) {
      console.log(`\n📊 Importing metrics from metrics/import/...\n`);
      const result = importMetrics(flags.date);
      if (result.status === "EXECUTED" && result.data) {
        const s = result.data;
        console.log(`  Date: ${s.date}`);
        console.log(`  Indexed pages: ${s.indexedPages}`);
        console.log(`  Top pages: ${s.topPages.length}`);
        console.log(`  Top queries: ${s.topQueries.length}`);
        console.log(`  Totals: ${s.totals.impressions.toLocaleString()} impressions, ${s.totals.clicks.toLocaleString()} clicks`);
        console.log(`  CTR: ${(s.totals.ctr * 100).toFixed(1)}%, Avg Position: ${s.totals.avgPosition.toFixed(1)}`);
        if (s.conversions) {
          console.log(`\n  Conversions:`);
          console.log(`    📞 Calls (CALL_CLICK): ${s.conversions.CALL_CLICK || 0}`);
          console.log(`    📋 Forms (FORM_SUBMIT): ${s.conversions.FORM_SUBMIT || 0}`);
          console.log(`    ⚖️  Weighted total: ${s.conversions.weightedTotal?.toFixed(1) || "0"}`);
        }
        if (s.topConversionPages && s.topConversionPages.length > 0) {
          console.log(`\n  Top Conversion Pages:`);
          for (const p of s.topConversionPages.slice(0, 5)) {
            console.log(`    ${p.weightedValue.toFixed(1)} wt | ${p.calls} calls | ${p.forms} forms | ${p.url}`);
          }
        }
        console.log(`\n  Snapshot saved to: metrics/snapshots/${s.date}.json`);
      } else {
        console.error(`❌ ${result.error?.message}`);
      }
    } else if (subcmd === "latest" || flags.latest) {
      const s = loadLatestSnapshot();
      if (s) {
        console.log(`\n📊 Latest Metric Snapshot: ${s.date}\n`);
        console.log(`  Indexed pages: ${s.indexedPages}`);
        console.log(`  Impressions: ${s.totals.impressions.toLocaleString()}`);
        console.log(`  Clicks: ${s.totals.clicks.toLocaleString()}`);
        console.log(`  CTR: ${(s.totals.ctr * 100).toFixed(1)}%`);
        console.log(`  Avg Position: ${s.totals.avgPosition.toFixed(1)}`);
        if (s.conversions) {
          console.log(`\n  Conversions:`);
          console.log(`    📞 Calls: ${s.conversions.CALL_CLICK || 0}`);
          console.log(`    📋 Forms: ${s.conversions.FORM_SUBMIT || 0}`);
          console.log(`    ⚖️  Weighted: ${s.conversions.weightedTotal?.toFixed(1) || "0"}`);
        }
        console.log(`\n  Top 5 Pages:`);
        for (const p of s.topPages.slice(0, 5)) {
          console.log(`    ${p.clicks} clicks | ${p.impressions} impr | pos ${p.position.toFixed(1)} | ${p.page}`);
        }
        console.log(`\n  Top 5 Queries:`);
        for (const q of s.topQueries.slice(0, 5)) {
          console.log(`    ${q.clicks} clicks | ${q.impressions} impr | pos ${q.position.toFixed(1)} | ${q.query}`);
        }
        if (s.topConversionPages && s.topConversionPages.length > 0) {
          console.log(`\n  Top 5 Conversion Pages:`);
          for (const p of s.topConversionPages.slice(0, 5)) {
            console.log(`    ${p.weightedValue.toFixed(1)} wt | ${p.calls} calls | ${p.forms} forms | ${p.url}`);
          }
        }
      } else {
        console.log("\nNo snapshots found. Run: mbs-master metrics --import");
      }
    }
    break;
  }

  // ============================================================
  // experiment — generate and manage experiments
  // ============================================================
  case "experiment": {
    const week = flags.week ? parseInt(flags.week) : currentWeekNumber();

    if (flags.new || !flags.list) {
      console.log(`\n🧪 Generating experiments for week ${week}...\n`);
      const result = generateWeeklyExperiments(week);
      if (result.status === "EXECUTED" && result.data) {
        for (const exp of result.data) {
          const typeLabel = exp.type === "conversion"
            ? `CONVERSION/${exp.conversionGoal || "MIXED"}`
            : exp.type.toUpperCase();
          console.log(`${typeLabel}: ${exp.name}`);
          console.log(`  ID: ${exp.id}`);
          console.log(`  Hypothesis: ${exp.hypothesis}`);
          console.log(`  Variants: ${exp.variants.map((v) => v.name).join(" vs ")}`);
          console.log(`  Success metric: ${exp.successMetric}`);
          console.log(`  Min sample: ${exp.minimumSampleSize} | Duration: ${exp.durationWeeks} weeks`);
          console.log(`  Stop rules:`);
          for (const rule of exp.stopRules) console.log(`    - ${rule}`);
          console.log(`  Rollback: ${exp.rollbackPlan}`);
          console.log("");
        }

        // Save to bundles directory if requested
        if (flags.save) {
          const outDir = join(process.cwd(), "bundles", "experiments");
          saveExperiments(outDir, result.data);
          console.log(`Saved to: ${outDir}`);
        }
      }
    }
    break;
  }

  default:
    console.log(`
MBS Master Orchestrator v${GENERATOR_VERSION}

Commands:
  plan        --week <n|current>
  run         --operator <n> --command <cmd> [--intent <n>] [--type <t>] ...
  bundle      [--week <n>] [--intent <n>]
  report      --weekly [--week <n>]
  status
  approve     --operator <n> --pack <path> --item <id|all>
  validate    --bundle <path>
  metrics     --import [--date YYYY-MM-DD]    Import GSC CSVs from metrics/import/
              --latest                        Show latest snapshot
  experiment  --new [--week <n>] [--save]     Generate weekly experiments
  help
`);
}
