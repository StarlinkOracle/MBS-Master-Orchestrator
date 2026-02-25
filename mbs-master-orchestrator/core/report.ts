import { resolve } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import type { MasterReport, KPITargets, OperatorConfig, ToolEnvelope, Experiment, MetricSnapshot, ConversionPageRow, EfficiencyRecommendation, CalibrationResult, WasteHunterOutput, FlowState } from "../types/index.js";
import { readJSON, nowISO, currentWeekNumber, findFiles, safeReadJSON, writeJSON, writeText, ensureDir, GENERATOR_VERSION } from "../utils/index.js";
import { scanApprovals } from "./approvals.js";
import { loadLatestSnapshot } from "./metrics/index.js";
import { generateWeeklyExperiments } from "./experiments.js";
import { loadConversionConfig, computeWeightedLeadValue } from "./metrics/conversions.js";
import { loadGeoPriorityConfig, getTier, getZipWeight, countIntentsByTier, getTier1ZipsSorted, getAllZipWeights } from "./geo/geoPriorityEngine.js";
import { runGeoWeightLearning, writeLearnerOutputs } from "./geo/geoWeightLearner.js";
import type { ZipMetricsInput } from "./geo/geoWeightLearner.js";
import { generateWeeklyPlan } from "./planner.js";
import { getCurrentSeason } from "./seasonality/seasonGate.js";
import { runCalibrationPipeline } from "./calibration/outcomeCalibration.js";
import { runWasteHunter } from "./ads/wasteHunter.js";
import { loadModeConfig, loadCapacityConfig, isCapacityAvailable, checkTierExpansion } from "./mode/conservativeGuard.js";
import { loadFlowControlConfig, applyFlowGovernor } from "./flow/flowGovernor.js";

const ROOT = process.cwd();

function loadKPIs(): KPITargets {
  return readJSON<KPITargets>(resolve(ROOT, "config/kpi_targets.json"));
}

function loadOperators(): OperatorConfig[] {
  return readJSON<{ operators: OperatorConfig[] }>(resolve(ROOT, "config/orchestrator.json")).operators.filter((o) => o.enabled);
}

/**
 * Overlay snapshot onto KPI current values.
 */
function resolveKPICurrents(kpi: KPITargets, snapshot: MetricSnapshot | null): KPITargets {
  const resolved = JSON.parse(JSON.stringify(kpi)) as KPITargets;
  if (snapshot?.indexedPages != null) {
    resolved.indexedPages.current = snapshot.indexedPages;
  }
  return resolved;
}

/**
 * Try to extract a 5-digit zip code from a URL path.
 * Returns null if no zip found.
 */
function extractZipFromUrl(url: string): string | null {
  const match = url.match(/\b(\d{5})\b/);
  return match ? match[1] : null;
}

export function generateWeeklyReport(weekNumber?: number): ToolEnvelope<MasterReport> {
  const week = weekNumber || currentWeekNumber();
  const kpiRaw = loadKPIs();
  const snapshot = loadLatestSnapshot();
  const kpi = resolveKPICurrents(kpiRaw, snapshot);
  const convConfig = loadConversionConfig();
  const operators = loadOperators();
  const approvalsResult = scanApprovals();
  const approvals = approvalsResult.data;

  const operatorSummaries: MasterReport["operatorSummaries"] = [];

  for (const op of operators) {
    const repoPath = resolve(ROOT, op.repoPath);
    const packsDir = resolve(repoPath, op.packGlob || "packs");

    let packsGenerated = 0;
    let validationScore = 0;
    let issues = 0;
    let approvalStatus: "pending" | "approved" | "rejected" = "pending";

    if (existsSync(packsDir)) {
      const checksFiles = findFiles(packsDir, "checks.json");
      packsGenerated = checksFiles.length;

      for (const cf of checksFiles) {
        const checks = safeReadJSON<any>(cf, { overallScore: 0, overallPassed: true, validators: {} });
        validationScore += checks.overallScore || 0;
        const validatorIssues = Object.values(checks.validators || {}) as any[];
        issues += validatorIssues.reduce((s: number, v: any) => s + (v.issues?.length || 0), 0);
      }

      if (packsGenerated > 0) validationScore = Math.round(validationScore / packsGenerated);

      const approvalFiles = findFiles(packsDir, "approval.json");
      const allApproved = approvalFiles.every((af) => {
        const a = safeReadJSON<any>(af, { overallStatus: "pending" });
        return a.overallStatus === "approved";
      });
      const anyRejected = approvalFiles.some((af) => {
        const a = safeReadJSON<any>(af, { overallStatus: "pending" });
        return a.overallStatus === "rejected";
      });

      approvalStatus = allApproved && approvalFiles.length > 0 ? "approved" : anyRejected ? "rejected" : "pending";
    }

    operatorSummaries.push({
      name: op.name,
      packsGenerated,
      validationScore,
      approvalStatus,
      issues,
    });
  }

  // Experiments
  let experiments: Experiment[] = [];
  const expResult = generateWeeklyExperiments(week);
  if (expResult.status === "EXECUTED" && expResult.data) {
    experiments = expResult.data;
  }

  // Next actions based on KPIs
  const nextActions: string[] = [];
  const blockedItems: string[] = [];
  const approvalIntegrityIssues: string[] = [];

  const pageGap = kpi.indexedPages.target - kpi.indexedPages.current;
  if (pageGap > 0) {
    const pagesPerWeek = Math.ceil(pageGap / 12);
    const source = snapshot ? ` (from ${snapshot.date} GSC data)` : " (static config)";
    nextActions.push(`INDEX ACCELERATION: Need ${pageGap} more pages. Currently ${kpi.indexedPages.current}/${kpi.indexedPages.target}${source}. Target ~${pagesPerWeek}/week.`);
  }
  if (kpi.weeklyGBPPosts.current < kpi.weeklyGBPPosts.target) {
    nextActions.push(`GBP CADENCE: Increase to ${kpi.weeklyGBPPosts.target} posts/week (currently ${kpi.weeklyGBPPosts.current}).`);
  }
  if (kpi.monthlyAdCampaigns.current < kpi.monthlyAdCampaigns.target) {
    nextActions.push(`AD CAMPAIGNS: Launch ${kpi.monthlyAdCampaigns.target - kpi.monthlyAdCampaigns.current} more campaigns this month.`);
  }
  if (kpi.monthlyLeads.current < kpi.monthlyLeads.target) {
    nextActions.push(`LEAD GENERATION: ${kpi.monthlyLeads.target - kpi.monthlyLeads.current} more leads needed to hit monthly target.`);
  }

  if (snapshot) {
    const lowCTR = snapshot.topPages.filter((p) => p.ctr < 0.03 && p.impressions > 100);
    if (lowCTR.length > 0) {
      nextActions.push(`CTR OPTIMIZATION: ${lowCTR.length} page(s) with CTR < 3% and 100+ impressions. Refresh titles/metas.`);
    }
  }

  // Conversion-specific actions
  if (snapshot?.conversions) {
    const calls = snapshot.conversions.CALL_CLICK || 0;
    const forms = snapshot.conversions.FORM_SUBMIT || 0;
    if (calls + forms > 0) {
      const callPct = Math.round((calls / (calls + forms)) * 100);
      nextActions.push(`CONVERSION MIX: ${calls} calls (${callPct}%) vs ${forms} forms (${100 - callPct}%). Weighted value: ${snapshot.conversions.weightedTotal?.toFixed(1) || "N/A"}. Optimize ${callPct > 60 ? "form paths to balance" : callPct < 40 ? "call paths to balance" : "both channels equally"}.`);
    }
  }

  if (approvals) {
    for (const reason of approvals.blockedReasons) {
      blockedItems.push(`[${reason.operator}/${reason.packId}] ${reason.reason}`);
    }
    for (const op of approvals.operators) {
      for (const pack of op.packs) {
        if (pack.hashIntegrity === "invalid") {
          approvalIntegrityIssues.push(
            `[${op.name}/${pack.packId}] Approval INVALIDATED — pack content hash changed after approval`
          );
        }
      }
    }
  }

  // Build conversion snapshot for report
  let conversionSnapshot: MasterReport["conversionSnapshot"];
  if (snapshot?.conversions && snapshot?.topConversionPages) {
    const pages = snapshot.topConversionPages;
    conversionSnapshot = {
      calls: snapshot.conversions.CALL_CLICK || 0,
      forms: snapshot.conversions.FORM_SUBMIT || 0,
      weightedTotal: snapshot.conversions.weightedTotal || 0,
      callDrivers: pages.filter((p) => p.calls > 0).sort((a, b) => b.calls - a.calls).slice(0, 10),
      formDrivers: pages.filter((p) => p.forms > 0).sort((a, b) => b.forms - a.forms).slice(0, 10),
    };
  }

  const report: MasterReport = {
    reportId: `report-w${week}-${nowISO().split("T")[0]}`,
    weekNumber: week,
    createdAt: nowISO(),
    kpiSnapshot: kpi,
    metricSnapshot: snapshot || null,
    operatorSummaries,
    experiments,
    nextActions,
    blockedItems,
    approvalIntegrityIssues,
    conversionSnapshot,
  };

  // ---- Geo distribution from planner ----
  const planResult = generateWeeklyPlan(week);
  if (planResult.status === "EXECUTED" && planResult.data) {
    const tierCounts = countIntentsByTier(planResult.data.intents);
    report.geoDistribution = {
      tier1_core: tierCounts.tier1_core || 0,
      tier2_upgrade: tierCounts.tier2_upgrade || 0,
      tier3_selective: tierCounts.tier3_selective || 0,
      tier4_boulder_reduced: tierCounts.tier4_boulder_reduced || 0,
    };

    // Suppressed zips (tier4 intents that got filtered out)
    // We detect these by checking original vs biased — for now, report zips with negative scores
    const geoConfig = loadGeoPriorityConfig();
    const boulderZips = geoConfig.tiers?.tier4_boulder_reduced?.zips || {};
    const suppressedInPlan = Object.entries(boulderZips)
      .filter(([zip, weight]) => weight < 0.93)
      .map(([zip, weight]) => ({ zip, reason: `Tier4 boulder ZIP ${zip} (weight ${weight}) below efficiency threshold` }));
    if (suppressedInPlan.length > 0) {
      report.suppressedZips = suppressedInPlan;
    }
  }

  // ---- Top 5 ZIPs by weighted profit efficiency ----
  if (snapshot?.topConversionPages && snapshot.topConversionPages.length > 0) {
    const zipProfit: { zip: string; tier: string; profitEfficiency: number; weightedLeadValue: number }[] = [];
    for (const page of snapshot.topConversionPages) {
      // Extract zip from URL if possible, otherwise use page URL as identifier
      const urlZip = extractZipFromUrl(page.url);
      const wlv = computeWeightedLeadValue(page.calls, page.forms, convConfig);
      const geoWeight = urlZip ? getZipWeight(urlZip) : 1.0;
      const tier = urlZip ? getTier(urlZip) : "unknown";
      zipProfit.push({
        zip: urlZip || page.url,
        tier: tier as string,
        profitEfficiency: Math.round(wlv * geoWeight * 100) / 100,
        weightedLeadValue: wlv,
      });
    }
    zipProfit.sort((a, b) => b.profitEfficiency - a.profitEfficiency);
    report.topProfitZips = zipProfit.slice(0, 5);
  }

  // ---- Season mode + blocked intents ----
  if (planResult.status === "EXECUTED" && planResult.data) {
    const plan = planResult.data;
    report.seasonMode = {
      season: plan.seasonMode || getCurrentSeason(),
      month: new Date().getMonth() + 1,
      blockedIntents: (plan.seasonBlocked || []).map((b) => b.reason),
    };
  }

  // ---- Calibration deltas ----
  const calResult = runCalibrationPipeline();
  if (calResult.status === "EXECUTED" && calResult.data) {
    const cal = calResult.data;
    report.calibrationDeltas = [
      { metric: "Call Close Rate", modeled: cal.callCloseRate.modeled, observed: cal.callCloseRate.observed, delta: cal.callCloseRate.delta },
      { metric: "Form Close Rate", modeled: cal.formCloseRate.modeled, observed: cal.formCloseRate.observed, delta: cal.formCloseRate.delta },
      { metric: "Avg Ticket (Call)", modeled: cal.avgTicketCall.modeled, observed: cal.avgTicketCall.observed, delta: cal.avgTicketCall.delta },
      { metric: "Avg Ticket (Form)", modeled: cal.avgTicketForm.modeled, observed: cal.avgTicketForm.observed, delta: cal.avgTicketForm.delta },
    ];
  }

  // ---- Waste hunter summary ----
  const wasteResult = runWasteHunter();
  if (wasteResult.status === "EXECUTED" && wasteResult.data) {
    const w = wasteResult.data;
    report.wasteHunterSummary = {
      totalTerms: w.totalTermsAnalyzed,
      negativeRecs: w.negativeRecommendations.length,
      matchTypeTightens: w.matchTypeTightenings.length,
      wastedSpend: w.summary.totalWastedSpend,
    };
  }

  // ---- Conservative mode status ----
  const modeConf = loadModeConfig();
  const capConf = loadCapacityConfig();
  const capAvailable = isCapacityAvailable(capConf);
  if (planResult.status === "EXECUTED" && planResult.data) {
    const plan = planResult.data;
    const expansionCheck = checkTierExpansion(
      plan.intents, 60, convConfig.targetCPL || 75, 1000, 500, modeConf, capConf
    );
    report.conservativeMode = {
      mode: modeConf.mode,
      capacityStatus: { backlogHours: capConf.currentBacklogHours, maxHours: capConf.maxBacklogHours, available: capAvailable },
      blockedScaleEvents: (plan.conservativeBlocked || []).length,
      pullbackTriggers: 0, // populated when efficiency data is provided
      travelInefficiencies: 0,
      tier2Allowed: expansionCheck.tier2Allowed,
      tier4Allowed: expansionCheck.tier4Allowed,
      expansionBlockReason: expansionCheck.blockedReason,
    };
  }

  // ---- Flow governor status ----
  const flowCfg = loadFlowControlConfig();
  const flowState = safeReadJSON<FlowState>(
    resolve(ROOT, "config/flow_state.json"),
    {
      qualifiedLeadsToday: 0,
      installLeadsThisWeek: 0,
      repairLeadsToday: 0,
      upgradeLeadsThisWeek: 0,
      totalLeadsThisWeek: 0,
      backlogHours: 0,
    }
  );

  const flowResult = applyFlowGovernor(
    planResult.status === "EXECUTED" && planResult.data ? planResult.data.intents : [],
    flowState,
    flowCfg
  );
  const upgradeRatio = flowState.totalLeadsThisWeek > 0
    ? Math.round((flowState.upgradeLeadsThisWeek / flowState.totalLeadsThisWeek) * 100) / 100
    : 0;
  report.flowGovernor = {
    leadsToday: flowState.qualifiedLeadsToday,
    leadsCap: flowCfg.maxQualifiedLeadsPerDay,
    installWeek: flowState.installLeadsThisWeek,
    installCap: flowCfg.maxInstallLeadsPerWeek,
    repairToday: flowState.repairLeadsToday,
    repairCap: flowCfg.maxRepairLeadsPerDay,
    upgradeRatio,
    upgradeMin: flowCfg.minUpgradeRatio,
    backlogHours: flowState.backlogHours,
    backlogBuffer: flowCfg.backlogBufferHours,
    decisions: flowResult.decisions,
    suppressedCount: flowResult.summary.totalSuppressed,
    reprioritizedCount: flowResult.summary.totalReprioritized,
    boostedCount: flowResult.summary.totalBoosted,
    flowMode: flowResult.summary.flowMode,
    effectiveLeads: flowResult.summary.effectiveLeads,
    rawLeads: flowResult.summary.rawLeads,
    hardCap: flowResult.summary.hardCap,
    softCap: flowResult.summary.softCap,
    overflowCap: flowResult.summary.overflowCap,
    lowTicketRepairShare: flowState.lowTicketRepairShareToday,
    maxLowTicketRepairShare: flowCfg.maxLowTicketRepairShare,
  };

  // ---- Geo weight learning ----
  const geoConfig = loadGeoPriorityConfig();
  if (geoConfig.learning?.enabled) {
    const convConfig = loadConversionConfig();
    // Build zip metrics from snapshot data (if available)
    const zipMetrics: ZipMetricsInput[] = [];
    const allWeights = getAllZipWeights();
    for (const zip of Object.keys(allWeights)) {
      // In production, these would come from CRM/ads data per ZIP
      // For now, placeholder — actual data loaded from metrics/import/zip_metrics.csv
      zipMetrics.push({ zip, calls: 0, forms: 0, spend: 0 });
    }

    // Try to load real zip metrics from import file
    const zipMetricsPath = resolve(ROOT, "metrics/import/zip_metrics.csv");
    if (existsSync(zipMetricsPath)) {
      try {
        const raw = readFileSync(zipMetricsPath, "utf-8");
        const lines2 = raw.split("\n").filter((l: string) => l.trim());
        if (lines2.length > 1) {
          const header = lines2[0].split(",").map((h: string) => h.trim().toLowerCase());
          const zipIdx = header.indexOf("zip");
          const callIdx = header.indexOf("calls");
          const formIdx = header.indexOf("forms");
          const spendIdx = header.indexOf("spend");
          if (zipIdx >= 0) {
            zipMetrics.length = 0; // clear placeholder data
            for (let i = 1; i < lines2.length; i++) {
              const cols = lines2[i].split(",").map((c: string) => c.trim());
              if (cols[zipIdx] && allWeights[cols[zipIdx]] != null) {
                zipMetrics.push({
                  zip: cols[zipIdx],
                  calls: parseInt(cols[callIdx] || "0", 10) || 0,
                  forms: parseInt(cols[formIdx] || "0", 10) || 0,
                  spend: parseFloat(cols[spendIdx] || "0") || 0,
                });
              }
            }
          }
        }
      } catch { /* skip if CSV parsing fails */ }
    }

    const learnerOutput = runGeoWeightLearning(zipMetrics, convConfig, geoConfig);

    // Write outputs to bundle
    const bundleDir = resolve(ROOT, "bundles", `week-${report.weekNumber}`);
    try {
      writeLearnerOutputs(learnerOutput, bundleDir);
    } catch { /* ok if bundle dir doesn't exist yet */ }

    report.geoLearning = {
      mode: learnerOutput.mode,
      zipsEvaluated: learnerOutput.zipsEvaluated,
      increases: learnerOutput.summary.increases,
      decreases: learnerOutput.summary.decreases,
      holds: learnerOutput.summary.holds,
      insufficientData: learnerOutput.summary.insufficientData,
      topPerformers: learnerOutput.topPerformers.slice(0, 10).map((p) => ({
        zip: p.zip,
        cpl: p.cpl,
        profitEfficiency: p.profitEfficiency,
        currentWeight: p.currentWeight,
        proposedWeight: learnerOutput.proposals.find((pr) => pr.zip === p.zip)?.proposedWeight ?? p.currentWeight,
      })),
      proposals: learnerOutput.proposals,
    };
  }

  return { status: "EXECUTED", data: report };
}

export function formatReportMarkdown(report: MasterReport): string {
  const lines: string[] = [
    `# Master Weekly Report — Week ${report.weekNumber}`,
    "",
    `**Report ID:** ${report.reportId}`,
    `**Generated:** ${report.createdAt}`,
    `**Generator:** v${GENERATOR_VERSION}`,
    "",
    "---",
    "",
    "## KPI Dashboard",
    "",
  ];

  const kpi = report.kpiSnapshot;
  const bar = (current: number, target: number) => {
    const pct = Math.min(100, Math.round((current / target) * 100));
    const filled = Math.round(pct / 5);
    return `${"█".repeat(filled)}${"░".repeat(20 - filled)} ${pct}% (${current}/${target})`;
  };

  if (kpi.indexedPages) lines.push(`**Indexed Pages:** ${bar(kpi.indexedPages.current, kpi.indexedPages.target)}`);
  if (kpi.weeklyGBPPosts) lines.push(`**Weekly GBP Posts:** ${bar(kpi.weeklyGBPPosts.current, kpi.weeklyGBPPosts.target)}`);
  if (kpi.monthlyAdCampaigns) lines.push(`**Monthly Ad Campaigns:** ${bar(kpi.monthlyAdCampaigns.current, kpi.monthlyAdCampaigns.target)}`);
  if (kpi.weeklyBlogPosts) lines.push(`**Weekly Blog Posts:** ${bar(kpi.weeklyBlogPosts.current, kpi.weeklyBlogPosts.target)}`);
  if (kpi.reviewVelocity) lines.push(`**Review Velocity:** ${bar(kpi.reviewVelocity.current, kpi.reviewVelocity.target)}`);
  if (kpi.monthlyLeads) lines.push(`**Monthly Leads:** ${bar(kpi.monthlyLeads.current, kpi.monthlyLeads.target)}`);

  // ---- Conversion KPI section ----
  if (report.conversionSnapshot) {
    const c = report.conversionSnapshot;
    lines.push("");
    lines.push("### Conversion Performance");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|---|---|`);
    lines.push(`| **Phone Calls (CALL_CLICK)** | ${c.calls} |`);
    lines.push(`| **Estimate Forms (FORM_SUBMIT)** | ${c.forms} |`);
    lines.push(`| **Weighted Total** (calls×1.0 + forms×0.7) | ${c.weightedTotal.toFixed(1)} |`);
    lines.push(`| **Call : Form Ratio** | ${c.calls + c.forms > 0 ? Math.round((c.calls / (c.calls + c.forms)) * 100) : 0}% : ${c.calls + c.forms > 0 ? Math.round((c.forms / (c.calls + c.forms)) * 100) : 0}% |`);
  }

  // Metric snapshot details
  if (report.metricSnapshot) {
    const s = report.metricSnapshot;
    lines.push("", `_Data source: GSC snapshot ${s.date} — ${s.totals.impressions.toLocaleString()} impressions, ${s.totals.clicks.toLocaleString()} clicks, ${(s.totals.ctr * 100).toFixed(1)}% CTR, avg position ${s.totals.avgPosition.toFixed(1)}_`);
  } else {
    lines.push("", "_No GSC snapshot available — KPIs use static config values. Run `mbs-master metrics --import` to ingest real data._");
  }

  // ---- What drove calls / forms tables ----
  if (report.conversionSnapshot) {
    const c = report.conversionSnapshot;

    if (c.callDrivers.length > 0) {
      lines.push("", "---", "", "## 📞 What Drove Calls", "");
      lines.push("| Page | Calls | Forms | Weighted |");
      lines.push("|---|---|---|---|");
      for (const p of c.callDrivers.slice(0, 8)) {
        lines.push(`| ${p.url} | **${p.calls}** | ${p.forms} | ${p.weightedValue.toFixed(1)} |`);
      }
    }

    if (c.formDrivers.length > 0) {
      lines.push("", "---", "", "## 📋 What Drove Forms", "");
      lines.push("| Page | Forms | Calls | Weighted |");
      lines.push("|---|---|---|---|");
      for (const p of c.formDrivers.slice(0, 8)) {
        lines.push(`| ${p.url} | **${p.forms}** | ${p.calls} | ${p.weightedValue.toFixed(1)} |`);
      }
    }
  }

  lines.push("", "---", "", "## Operator Status", "");

  // ---- Geo Priority Distribution ----
  if (report.geoDistribution) {
    const g = report.geoDistribution;
    const total = g.tier1_core + g.tier2_upgrade + g.tier3_selective + g.tier4_boulder_reduced;
    lines.splice(lines.length - 1, 0,
      "", "---", "", "## 🗺️ Geo Priority Distribution", "",
      "| Tier | Actions | % of Total |",
      "|---|---|---|",
      `| **Tier 1 Core** (high-income) | ${g.tier1_core} | ${total > 0 ? Math.round(g.tier1_core / total * 100) : 0}% |`,
      `| **Tier 2 Upgrade** (expansion) | ${g.tier2_upgrade} | ${total > 0 ? Math.round(g.tier2_upgrade / total * 100) : 0}% |`,
      `| **Tier 3 Selective** | ${g.tier3_selective} | ${total > 0 ? Math.round(g.tier3_selective / total * 100) : 0}% |`,
      `| **Tier 4 Boulder** (reduced) | ${g.tier4_boulder_reduced} | ${total > 0 ? Math.round(g.tier4_boulder_reduced / total * 100) : 0}% |`,
      ""
    );
  }

  // ---- Top 5 ZIPs by Weighted Profit Efficiency ----
  if (report.topProfitZips && report.topProfitZips.length > 0) {
    lines.splice(lines.length - 1, 0,
      "", "## 💰 Top 5 ZIPs by Weighted Profit Efficiency", "",
      "| ZIP/Page | Tier | Lead Value | Geo-Adjusted Profit |",
      "|---|---|---|---|",
      ...report.topProfitZips.map(z =>
        `| ${z.zip} | ${z.tier} | $${z.weightedLeadValue.toFixed(2)} | $${z.profitEfficiency.toFixed(2)} |`
      ),
      ""
    );
  }

  // ---- Suppressed ZIPs ----
  if (report.suppressedZips && report.suppressedZips.length > 0) {
    lines.splice(lines.length - 1, 0,
      "", "## ⛔ Suppressed ZIPs", "",
      "| ZIP | Reason |",
      "|---|---|",
      ...report.suppressedZips.map(s => `| ${s.zip} | ${s.reason} |`),
      ""
    );
  }

  // ---- Efficiency Guard Recommendations ----
  if (report.efficiencyRecommendations && report.efficiencyRecommendations.length > 0) {
    const recs = report.efficiencyRecommendations;
    lines.splice(lines.length - 1, 0,
      "", "## 🛡️ Efficiency Guard Recommendations", "",
      "| ZIP | Tier | Action | Current Bid | → Recommended | CPL |",
      "|---|---|---|---|---|---|",
      ...recs.map(r =>
        `| ${r.zip} | ${r.tier} | ${r.action} | ${r.currentBidModifier}% | ${r.recommendedBidModifier}% | $${r.costPerWeightedLead.toFixed(2)} |`
      ),
      ""
    );
  }

  // ---- Season Mode ----
  if (report.seasonMode) {
    const sm = report.seasonMode;
    const seasonEmoji = sm.season === "HEATING" ? "🔥" : sm.season === "COOLING" ? "❄️" : "🔄";
    lines.splice(lines.length - 1, 0,
      "", "---", "", `## ${seasonEmoji} Season Mode: ${sm.season}`, "",
      `**Active Month:** ${sm.month}`,
    );
    if (sm.blockedIntents.length > 0) {
      lines.splice(lines.length - 1, 0,
        "", `**Blocked Intents (${sm.blockedIntents.length}):**`,
      );
      for (const b of sm.blockedIntents) {
        lines.splice(lines.length - 1, 0, `- ⛔ ${b}`);
      }
    } else {
      lines.splice(lines.length - 1, 0, "", "✅ No intents blocked by season gate.");
    }
    lines.splice(lines.length - 1, 0, "");
  }

  // ---- Calibration: Modeled vs Observed ----
  if (report.calibrationDeltas && report.calibrationDeltas.length > 0) {
    lines.splice(lines.length - 1, 0,
      "", "---", "", "## 🎯 Calibration: Modeled vs Observed", "",
      "| Metric | Modeled | Observed | Delta |",
      "|---|---|---|---|",
      ...report.calibrationDeltas.map(d => {
        const isRate = d.metric.includes("Rate");
        const fmt = (n: number) => isRate ? `${(n * 100).toFixed(1)}%` : `$${n.toFixed(2)}`;
        const deltaFmt = isRate ? `${(d.delta * 100).toFixed(1)}pp` : `$${d.delta.toFixed(2)}`;
        const arrow = d.delta > 0 ? "⬆️" : d.delta < 0 ? "⬇️" : "➡️";
        return `| ${d.metric} | ${fmt(d.modeled)} | ${fmt(d.observed)} | ${arrow} ${deltaFmt} |`;
      }),
      "",
      "_Proposed updates written to config/learned.json (approval-gated)._",
      ""
    );
  }

  // ---- Waste Hunter Summary ----
  if (report.wasteHunterSummary) {
    const w = report.wasteHunterSummary;
    lines.splice(lines.length - 1, 0,
      "", "---", "", "## 🗑️ Waste Hunter Summary", "",
      `**Terms Analyzed:** ${w.totalTerms}`,
      `**Wasted Spend Found:** $${w.wastedSpend.toFixed(2)}`,
      "",
      "| Action | Count |",
      "|---|---|",
      `| Negative keyword recommendations | ${w.negativeRecs} |`,
      `| Match-type tightening suggestions | ${w.matchTypeTightens} |`,
      "",
      "_See ads/waste_hunter_summary.md for full details._",
      ""
    );
  }

  // ---- Conservative Mode Status ----
  if (report.conservativeMode) {
    const cm = report.conservativeMode;
    const capIcon = cm.capacityStatus.available ? "✅" : "⛔";
    const t2Icon = cm.tier2Allowed ? "✅" : "⛔";
    const t4Icon = cm.tier4Allowed ? "✅" : "⛔";
    lines.splice(lines.length - 1, 0,
      "", "---", "", `## 🛡️ Operating Mode: ${cm.mode}`, "",
      `**Capacity:** ${capIcon} ${cm.capacityStatus.backlogHours}h / ${cm.capacityStatus.maxHours}h max`,
      `**Tier2 Expansion:** ${t2Icon} ${cm.tier2Allowed ? "allowed" : "blocked"}`,
      `**Tier4 Boulder:** ${t4Icon} ${cm.tier4Allowed ? "allowed" : "blocked"}`,
      "",
      "| Metric | Value |",
      "|---|---|",
      `| Blocked scale events | ${cm.blockedScaleEvents} |`,
      `| Pullback triggers | ${cm.pullbackTriggers} |`,
      `| Travel inefficiencies | ${cm.travelInefficiencies} |`,
    );
    if (cm.expansionBlockReason) {
      lines.splice(lines.length - 1, 0, "", `**Block Reason:** ${cm.expansionBlockReason}`);
    }
    lines.splice(lines.length - 1, 0, "");
  }

  // ---- Lead Flow Status ----
  if (report.flowGovernor) {
    const fg = report.flowGovernor;
    const leadPct = fg.leadsCap > 0 ? Math.round((fg.leadsToday / fg.leadsCap) * 100) : 0;
    const installPct = fg.installCap > 0 ? Math.round((fg.installWeek / fg.installCap) * 100) : 0;
    const repairPct = fg.repairCap > 0 ? Math.round((fg.repairToday / fg.repairCap) * 100) : 0;
    const upIcon = fg.upgradeRatio >= fg.upgradeMin ? "✅" : "⬆️";
    const backlogIcon = fg.backlogHours > fg.backlogBuffer ? "🔴" : fg.backlogHours > fg.backlogBuffer * 0.75 ? "🟡" : "🟢";

    const modeEmoji = fg.flowMode === "NORMAL" ? "🟢" : fg.flowMode === "WAITLIST" ? "🟡" : fg.flowMode === "THROTTLE" ? "🟠" : "🔴";
    const modeLabel = fg.flowMode || "NORMAL";

    lines.splice(lines.length - 1, 0,
      "", "---", "", `## 🚰 Lead Flow Status — ${modeEmoji} ${modeLabel}`, "",
    );

    // Show thresholds if soft caps available
    if (fg.hardCap != null && fg.softCap != null && fg.overflowCap != null) {
      const effLabel = fg.effectiveLeads != null && fg.effectiveLeads !== fg.rawLeads
        ? `${fg.effectiveLeads} effective (${fg.rawLeads} raw, quality-discounted)`
        : `${fg.leadsToday}`;
      lines.splice(lines.length - 1, 0,
        "| Threshold | Value | Status |",
        "|---|---|---|",
        `| Hard Cap | ${fg.hardCap}/day | ${(fg.effectiveLeads ?? fg.leadsToday) <= fg.hardCap ? "🟢 under" : "⚠️ exceeded"} |`,
        `| Soft Cap | ${fg.softCap}/day | ${(fg.effectiveLeads ?? fg.leadsToday) <= fg.softCap ? "OK" : "⚠️ exceeded"} |`,
        `| Overflow | ${fg.overflowCap}/day | ${(fg.effectiveLeads ?? fg.leadsToday) <= fg.overflowCap ? "OK" : "🔴 exceeded"} |`,
        `| **Effective Leads** | **${effLabel}** | |`,
        "",
      );
    }

    lines.splice(lines.length - 1, 0,
      "| Metric | Current | Cap | Status |",
      "|---|---|---|---|",
      `| Leads Today | ${fg.leadsToday} | ${fg.leadsCap}/day | ${leadPct >= 100 ? "🔴" : leadPct >= 75 ? "🟡" : "🟢"} ${leadPct}% |`,
      `| Install Leads (Week) | ${fg.installWeek} | ${fg.installCap}/week | ${installPct >= 100 ? "🔴" : installPct >= 75 ? "🟡" : "🟢"} ${installPct}% |`,
      `| Repair Leads Today | ${fg.repairToday} | ${fg.repairCap}/day | ${repairPct >= 100 ? "🔴" : repairPct >= 75 ? "🟡" : "🟢"} ${repairPct}% |`,
      `| Upgrade Ratio | ${(fg.upgradeRatio * 100).toFixed(0)}% | ≥${(fg.upgradeMin * 100).toFixed(0)}% | ${upIcon} |`,
      `| Backlog | ${fg.backlogHours}h | ${fg.backlogBuffer}h buffer | ${backlogIcon} |`,
    );

    // Low-ticket repair share
    if (fg.lowTicketRepairShare != null && fg.maxLowTicketRepairShare != null) {
      const repSharePct = (fg.lowTicketRepairShare * 100).toFixed(0);
      const repShareMax = (fg.maxLowTicketRepairShare * 100).toFixed(0);
      const repShareIcon = fg.lowTicketRepairShare > fg.maxLowTicketRepairShare ? "🔴" : "🟢";
      lines.splice(lines.length - 1, 0,
        `| Low-Ticket Repair Share | ${repSharePct}% | ≤${repShareMax}% | ${repShareIcon} |`,
      );
    }
    lines.splice(lines.length - 1, 0, "");

    if (fg.decisions.length > 0) {
      lines.splice(lines.length - 1, 0,
        "**Flow Governor Actions:**", "",
      );
      for (const d of fg.decisions) {
        const icon = d.severity === "critical" ? "🔴" : d.severity === "warning" ? "🟡" : "ℹ️";
        lines.splice(lines.length - 1, 0, `- ${icon} **${d.action}**: ${d.reason}`);
      }
      lines.splice(lines.length - 1, 0, "");
    }

    if (fg.suppressedCount > 0 || fg.reprioritizedCount > 0 || fg.boostedCount > 0) {
      lines.splice(lines.length - 1, 0,
        "| Modification | Count |",
        "|---|---|",
        `| Intents suppressed | ${fg.suppressedCount} |`,
        `| Intents reprioritized | ${fg.reprioritizedCount} |`,
        `| Intents boosted | ${fg.boostedCount} |`,
        "",
      );
    } else if (fg.decisions.length === 0) {
      lines.splice(lines.length - 1, 0, "✅ No flow governor interventions needed.", "");
    } else {
      lines.splice(lines.length - 1, 0, "⚠️ Limits triggered — planner already applied restrictions.", "");
    }
  }

  // ---- ZIP Performance Learning ----
  if (report.geoLearning) {
    const gl = report.geoLearning;
    lines.splice(lines.length - 1, 0,
      "", "---", "", "## 📍 ZIP Performance Learning", "",
      `**Mode:** ${gl.mode} | **ZIPs Evaluated:** ${gl.zipsEvaluated}`,
      `**Proposals:** ${gl.increases} ⬆️ increase, ${gl.decreases} ⬇️ decrease, ${gl.holds} hold, ${gl.insufficientData} insufficient data`,
      "",
    );

    if (gl.topPerformers.length > 0) {
      lines.splice(lines.length - 1, 0,
        "**Top Performers (by Profit Efficiency):**", "",
        "| ZIP | CPL | Profit Eff. | Weight | Proposed |",
        "|-----|-----|-------------|--------|----------|",
      );
      for (const p of gl.topPerformers) {
        const arrow = p.proposedWeight > p.currentWeight ? " ⬆️" : p.proposedWeight < p.currentWeight ? " ⬇️" : "";
        lines.splice(lines.length - 1, 0,
          `| ${p.zip} | $${p.cpl} | $${p.profitEfficiency} | ${p.currentWeight} | ${p.proposedWeight}${arrow} |`
        );
      }
      lines.splice(lines.length - 1, 0, "");
    }

    if (gl.proposals.length > 0) {
      lines.splice(lines.length - 1, 0,
        "**Weight Change Proposals (approval required):**", "",
        "| ZIP | Current → Proposed | Reason |",
        "|-----|-------------------|--------|",
      );
      for (const p of gl.proposals) {
        const arrow = p.delta > 0 ? "⬆️" : "⬇️";
        lines.splice(lines.length - 1, 0,
          `| ${p.zip} | ${p.currentWeight} → ${p.proposedWeight} ${arrow} | ${p.reason} |`
        );
      }
      lines.splice(lines.length - 1, 0, "");
    }

    if (gl.insufficientData > 0) {
      lines.splice(lines.length - 1, 0,
        `> ℹ️ ${gl.insufficientData} ZIPs have insufficient data (< 5 leads) — no weight adjustments proposed.`,
        "",
      );
    }
  }

  for (const op of report.operatorSummaries) {
    const icon = op.approvalStatus === "approved" ? "✅" : op.approvalStatus === "rejected" ? "❌" : "⏳";
    lines.push(`### ${icon} ${op.name}`);
    lines.push(`- Packs generated: ${op.packsGenerated}`);
    lines.push(`- Validation score: ${op.validationScore}/100`);
    lines.push(`- Approval status: ${op.approvalStatus}`);
    lines.push(`- Issues: ${op.issues}`);
    lines.push("");
  }

  // Experiments section
  if (report.experiments.length > 0) {
    lines.push("---", "", "## 🧪 Experiments to Run Next Week", "");
    for (const exp of report.experiments) {
      const typeLabel = exp.type === "conversion"
        ? `CONVERSION/${exp.conversionGoal || "MIXED"}`
        : exp.type.toUpperCase();
      lines.push(`### ${typeLabel}: ${exp.name}`);
      lines.push(`- **ID:** ${exp.id}`);
      lines.push(`- **Hypothesis:** ${exp.hypothesis}`);
      lines.push(`- **Success metric:** ${exp.successMetric}`);
      lines.push(`- **Min sample size:** ${exp.minimumSampleSize}`);
      lines.push(`- **Duration:** ${exp.durationWeeks} weeks`);
      lines.push(`- **Variants:** ${exp.variants.map((v) => v.name).join(" vs ")}`);
      lines.push(`- **Stop rules:**`);
      for (const rule of exp.stopRules) lines.push(`  - ${rule}`);
      lines.push(`- **Rollback plan:** ${exp.rollbackPlan}`);
      lines.push(`- **Status:** ${exp.status}`);
      lines.push("");
    }
  }

  // Approval integrity
  if (report.approvalIntegrityIssues.length > 0) {
    lines.push("---", "", "## 🔴 Approval Integrity Issues", "");
    for (const issue of report.approvalIntegrityIssues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }

  if (report.nextActions.length > 0) {
    lines.push("---", "", "## Next Actions", "");
    for (const action of report.nextActions) {
      lines.push(`1. ${action}`);
    }
    lines.push("");
  }

  if (report.blockedItems.length > 0) {
    lines.push("---", "", "## ⛔ Blocked Items", "");
    for (const item of report.blockedItems) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  lines.push("---", "", `_Report generated by mbs-master-orchestrator v${GENERATOR_VERSION}_`);

  return lines.join("\n");
}
