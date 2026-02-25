import type { BundleManifest, BundleChecks } from "../types/index.js";

export function generateBundleDiff(
  bundleId: string,
  manifest: BundleManifest,
  checks: BundleChecks
): string {
  const lines: string[] = [
    `# Bundle Diff: ${bundleId}`,
    "",
    `**Week:** ${manifest.weekNumber}`,
    `**Generated:** ${manifest.createdAt}`,
    `**Hash:** ${manifest.deterministicHash.slice(0, 24)}...`,
    `**Generator:** v${manifest.generatorVersion}`,
    "",
    "---",
    "",
    "## Operators",
    "",
  ];

  for (const op of manifest.operators) {
    lines.push(`### ${op.name}`);
    lines.push("");
    lines.push(`- **Packs:** ${op.packIds.length}`);
    lines.push(`- **Validation:** ${op.checksOverall.passed ? "passed" : "FAILED"} (${op.checksOverall.score}/100)`);
    lines.push(`- **Approval:** ${op.approvalStatus}`);

    if (op.packIds.length > 0) {
      lines.push("- **Pack IDs:**");
      for (const pid of op.packIds) {
        lines.push(`  - ${pid}`);
      }
    }
    lines.push("");
  }

  lines.push("## Validation Summary", "");
  for (const [name, result] of Object.entries(checks.validators)) {
    const icon = result.passed ? "✅" : "❌";
    lines.push(`${icon} **${name}:** ${result.score}/100`);
    for (const issue of result.issues) {
      const sev = issue.severity === "error" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
      lines.push(`  - ${sev} [${issue.code}] ${issue.message}`);
    }
    lines.push("");
  }

  lines.push("## KPI Snapshot", "");
  const kpi = manifest.kpiSnapshot;
  if (kpi.indexedPages) lines.push(`- Indexed Pages: ${kpi.indexedPages.current} / ${kpi.indexedPages.target}`);
  if (kpi.weeklyGBPPosts) lines.push(`- Weekly GBP Posts: ${kpi.weeklyGBPPosts.current} / ${kpi.weeklyGBPPosts.target}`);
  if (kpi.monthlyAdCampaigns) lines.push(`- Monthly Ad Campaigns: ${kpi.monthlyAdCampaigns.current} / ${kpi.monthlyAdCampaigns.target}`);
  if (kpi.weeklyBlogPosts) lines.push(`- Weekly Blog Posts: ${kpi.weeklyBlogPosts.current} / ${kpi.weeklyBlogPosts.target}`);
  if (kpi.reviewVelocity) lines.push(`- Review Velocity: ${kpi.reviewVelocity.current} / ${kpi.reviewVelocity.target} ${kpi.reviewVelocity.unit}`);
  if (kpi.monthlyLeads) lines.push(`- Monthly Leads: ${kpi.monthlyLeads.current} / ${kpi.monthlyLeads.target}`);
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("_Note: This is the initial bundle — no previous version to diff against._");
  lines.push("_Future bundles will show added/removed/changed packs._");

  return lines.join("\n");
}
