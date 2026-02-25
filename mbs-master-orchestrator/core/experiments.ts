import { resolve, join } from "path";
import { existsSync } from "fs";
import type { Experiment, ExperimentVariant, MetricSnapshot, ToolEnvelope, ConversionGoal } from "../types/index.js";
import { deterministicHash, nowISO, currentWeekNumber, writeJSON, ensureDir } from "../utils/index.js";
import { loadLatestSnapshot } from "./metrics/index.js";

// ============================================================
// SEO Experiment Templates
// ============================================================

const SEO_TEMPLATES = [
  {
    name: "Internal Link Density Test",
    hypothesis: "Increasing internal links from 5 to 8 per GEO page will improve average position by 0.5+ within 4 weeks",
    successMetric: "avg_position_improvement",
    minimumSampleSize: 10,
    durationWeeks: 4,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const weakPages = snapshot?.topPages.filter((p) => p.position > 8).slice(0, 5) || [];
      return [
        {
          id: "control",
          name: "Current link density",
          description: "Keep existing 3-5 internal links per page",
          config: { internalLinks: 5, pages: weakPages.map((p) => p.page) },
        },
        {
          id: "variant-a",
          name: "High link density",
          description: "Increase to 8 internal links with pillar page anchors",
          config: { internalLinks: 8, addPillarLinks: true, pages: weakPages.map((p) => p.page) },
        },
      ];
    },
    stopRules: [
      "Stop if any test page drops below position 20 for 7 consecutive days",
      "Stop if organic clicks decrease by more than 30% week-over-week",
      "Stop if crawl errors increase on test pages",
    ],
    rollbackPlan: "Revert internal link count to pre-test levels using config_snapshot.json from the pack that preceded the experiment",
  },
  {
    name: "Title Tag CTR Optimization",
    hypothesis: "Adding the city name as the first word in title tags will improve CTR by 15%+ on GEO pages within 3 weeks",
    successMetric: "ctr_improvement",
    minimumSampleSize: 500,
    durationWeeks: 3,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const geoPages = snapshot?.topPages.filter((p) => p.page.includes("/service-areas/")).slice(0, 5) || [];
      return [
        {
          id: "control",
          name: "Service-first title format",
          description: "Current: 'Heat Pump Installation in Denver, CO'",
          config: { titleFormat: "{service} in {city}, CO", pages: geoPages.map((p) => p.page) },
        },
        {
          id: "variant-a",
          name: "City-first title format",
          description: "Test: 'Denver Heat Pump Installation | Russell Comfort Solutions'",
          config: { titleFormat: "{city} {service} | Russell Comfort Solutions", pages: geoPages.map((p) => p.page) },
        },
      ];
    },
    stopRules: [
      "Stop if impressions drop by more than 25% across test pages",
      "Stop if brand search volume decreases by 20%",
    ],
    rollbackPlan: "Restore original title tags from the pack's content JSON snapshots",
  },
  {
    name: "FAQ Expansion Test",
    hypothesis: "Expanding FAQs from 3 to 6 per service page with schema markup will increase impressions by 20%+ in 4 weeks",
    successMetric: "impressions_growth",
    minimumSampleSize: 8,
    durationWeeks: 4,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const servicePages = snapshot?.topPages.filter((p) => p.page.includes("/services/")).slice(0, 5) || [];
      return [
        {
          id: "control",
          name: "Standard 3 FAQs",
          description: "Keep current 3 FAQs per page with existing schema",
          config: { faqCount: 3, schemaMarkup: true, pages: servicePages.map((p) => p.page) },
        },
        {
          id: "variant-a",
          name: "Expanded 6 FAQs",
          description: "Add 3 additional FAQs targeting long-tail queries from GSC data",
          config: { faqCount: 6, schemaMarkup: true, sourceLongTail: true, pages: servicePages.map((p) => p.page) },
        },
      ];
    },
    stopRules: [
      "Stop if page load time increases by more than 500ms",
      "Stop if bounce rate increases by more than 15%",
    ],
    rollbackPlan: "Remove added FAQs and revert to 3-FAQ layout using pre-experiment content snapshot",
  },
];

// ============================================================
// Ads Experiment Templates
// ============================================================

const ADS_TEMPLATES = [
  {
    name: "RSA Headline Set Test",
    hypothesis: "Using benefit-focused headlines ('Save $X on energy bills') will outperform feature-focused headlines ('High-efficiency heat pump') by 20%+ CTR in 2 weeks",
    successMetric: "ad_ctr_improvement",
    minimumSampleSize: 1000,
    durationWeeks: 2,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const topQuery = snapshot?.topQueries[0]?.query || "heat pump installation denver";
      return [
        {
          id: "control",
          name: "Feature-focused headlines",
          description: "Headlines emphasize product features and technical specs",
          config: {
            headlines: [
              "High-Efficiency Heat Pumps",
              "Professional HVAC Install",
              "Licensed Denver Technicians",
            ],
            targetQuery: topQuery,
          },
        },
        {
          id: "variant-a",
          name: "Benefit-focused headlines",
          description: "Headlines emphasize customer outcomes and savings",
          config: {
            headlines: [
              "Cut Energy Bills 30-50%",
              "Comfort Guaranteed",
              "Same-Day Estimates Free",
            ],
            targetQuery: topQuery,
          },
        },
      ];
    },
    stopRules: [
      "Stop if cost-per-click exceeds 2x the baseline CPC",
      "Stop if quality score drops below 5 on any keyword",
      "Stop if daily spend exceeds budget cap by 20%",
    ],
    rollbackPlan: "Pause variant ad group and reactivate control ad group in Google Ads dashboard",
  },
  {
    name: "Keyword Cluster Test",
    hypothesis: "Grouping keywords by service intent (install vs repair vs maintenance) in separate ad groups will improve conversion rate by 15%+ over 3 weeks",
    successMetric: "conversion_rate_improvement",
    minimumSampleSize: 200,
    durationWeeks: 3,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const queries = snapshot?.topQueries || [];
      const installQueries = queries.filter((q) => q.query.includes("install")).slice(0, 5);
      const repairQueries = queries.filter((q) => q.query.includes("repair")).slice(0, 5);
      return [
        {
          id: "control",
          name: "Mixed service ad group",
          description: "All service keywords in a single ad group with shared ads",
          config: {
            structure: "single_adgroup",
            keywords: queries.slice(0, 10).map((q) => q.query),
          },
        },
        {
          id: "variant-a",
          name: "Intent-segmented ad groups",
          description: "Separate ad groups for install, repair, and maintenance keywords with tailored ad copy",
          config: {
            structure: "segmented_adgroups",
            installKeywords: installQueries.map((q) => q.query),
            repairKeywords: repairQueries.map((q) => q.query),
          },
        },
      ];
    },
    stopRules: [
      "Stop if overall campaign CPA exceeds 2x the target CPA",
      "Stop if any ad group has zero conversions after 500 clicks",
      "Stop if daily budget is exhausted before 2 PM consistently",
    ],
    rollbackPlan: "Consolidate ad groups back to single-group structure and reactivate original keyword set",
  },
  {
    name: "Meta Audience Expansion Test",
    hypothesis: "Expanding Meta retargeting from 30-day to 60-day window will increase lead volume by 25%+ while keeping CPA within 110% of baseline over 2 weeks",
    successMetric: "lead_volume_at_cpa",
    minimumSampleSize: 150,
    durationWeeks: 2,
    makeVariants: (): ExperimentVariant[] => [
      {
        id: "control",
        name: "30-day retargeting window",
        description: "Current: retarget visitors from last 30 days",
        config: { retargetDays: 30, audience: "website_visitors" },
      },
      {
        id: "variant-a",
        name: "60-day retargeting window",
        description: "Expanded: retarget visitors from last 60 days",
        config: { retargetDays: 60, audience: "website_visitors" },
      },
    ],
    stopRules: [
      "Stop if CPA exceeds 130% of baseline for 3 consecutive days",
      "Stop if ad frequency exceeds 8 per user per week",
    ],
    rollbackPlan: "Reset audience window to 30 days in Meta Ads Manager",
  },
];

// ============================================================
// Call Conversion Experiment Templates
// ============================================================

const CALL_CONVERSION_TEMPLATES = [
  {
    name: "Repair Page CTA Placement Test",
    hypothesis: "Moving the phone CTA above the fold on repair pages will increase CALL_CLICK events by 25%+ in 3 weeks",
    successMetric: "call_click_increase",
    minimumSampleSize: 200,
    durationWeeks: 3,
    conversionGoal: "CALL_CLICK" as ConversionGoal,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const repairPages = snapshot?.topConversionPages
        ?.filter((p) => p.calls > p.forms).slice(0, 3).map((p) => p.url) || ["/services/furnace-repair", "/services/ac-repair"];
      return [
        {
          id: "control",
          name: "CTA below hero section",
          description: "Current: phone number in header bar and below hero image",
          config: { ctaPosition: "below-hero", stickyHeader: false, pages: repairPages },
        },
        {
          id: "variant-a",
          name: "CTA above fold + sticky",
          description: "Phone CTA prominently above fold with sticky header CTA on scroll",
          config: { ctaPosition: "above-fold", stickyHeader: true, emergencyBadge: true, pages: repairPages },
        },
      ];
    },
    stopRules: [
      "Stop if page bounce rate increases by 20%+ on test pages",
      "Stop if overall site CALL_CLICK events drop by 15%",
      "Stop if form submissions on repair pages drop by 30%",
    ],
    rollbackPlan: "Revert CTA position to below-hero layout using pre-experiment page template snapshot",
  },
  {
    name: "Trust Block Placement for Calls",
    hypothesis: "Adding a license/insurance trust block immediately before the phone CTA on repair pages will increase CALL_CLICK by 20%+ in 2 weeks",
    successMetric: "call_click_increase",
    minimumSampleSize: 150,
    durationWeeks: 2,
    conversionGoal: "CALL_CLICK" as ConversionGoal,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const repairPages = snapshot?.topConversionPages
        ?.filter((p) => p.calls > 0).slice(0, 4).map((p) => p.url) || ["/services/furnace-repair"];
      return [
        {
          id: "control",
          name: "Trust block in sidebar",
          description: "Current: license/insurance badges in sidebar only",
          config: { trustBlockPosition: "sidebar", pages: repairPages },
        },
        {
          id: "variant-a",
          name: "Trust block before CTA",
          description: "License, insurance, and BBB badges placed directly above phone CTA",
          config: { trustBlockPosition: "above-cta", badges: ["licensed", "insured", "bbb-a+"], pages: repairPages },
        },
      ];
    },
    stopRules: [
      "Stop if page load time increases by 300ms+",
      "Stop if CALL_CLICK drops below baseline for 5 consecutive days",
    ],
    rollbackPlan: "Remove inline trust block and restore sidebar-only layout",
  },
  {
    name: "Ad Copy Call Intent Test",
    hypothesis: "Using 'Call Now' sitelinks and call-focused ad copy for repair keywords will increase phone conversions by 30%+ in 2 weeks",
    successMetric: "call_conversions_from_ads",
    minimumSampleSize: 300,
    durationWeeks: 2,
    conversionGoal: "CALL_CLICK" as ConversionGoal,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const repairQueries = snapshot?.topQueries
        ?.filter((q) => q.query.includes("repair")).slice(0, 5).map((q) => q.query) || ["furnace repair denver"];
      return [
        {
          id: "control",
          name: "Generic ad copy",
          description: "Current ad copy with standard sitelinks",
          config: { sitelinks: ["Services", "About Us", "Reviews"], keywords: repairQueries },
        },
        {
          id: "variant-a",
          name: "Call-intent ad copy",
          description: "Ad copy with 'Call Now', phone extensions, and urgency language",
          config: { sitelinks: ["Call Now", "24/7 Service", "Same-Day Repair"], callExtension: true, keywords: repairQueries },
        },
      ];
    },
    stopRules: [
      "Stop if CPC exceeds 2x baseline on test keywords",
      "Stop if form leads drop by 40%+ (over-optimizing for calls)",
    ],
    rollbackPlan: "Restore generic ad copy and standard sitelinks",
  },
];

// ============================================================
// Form Conversion Experiment Templates
// ============================================================

const FORM_CONVERSION_TEMPLATES = [
  {
    name: "Estimate Form Module Placement Test",
    hypothesis: "Embedding a short estimate request form inline on install pages (instead of separate /contact page) will increase FORM_SUBMIT by 35%+ in 3 weeks",
    successMetric: "form_submit_increase",
    minimumSampleSize: 100,
    durationWeeks: 3,
    conversionGoal: "FORM_SUBMIT" as ConversionGoal,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const installPages = snapshot?.topConversionPages
        ?.filter((p) => p.forms > p.calls).slice(0, 3).map((p) => p.url) || ["/services/heat-pump-installation"];
      return [
        {
          id: "control",
          name: "Link to /contact page",
          description: "Current: 'Get a Free Estimate' button links to /contact",
          config: { formType: "link-to-contact", pages: installPages },
        },
        {
          id: "variant-a",
          name: "Inline 3-field form",
          description: "Inline form (name, phone, service) embedded after service description",
          config: { formType: "inline-3-field", fields: ["name", "phone", "service_interest"], pages: installPages },
        },
      ];
    },
    stopRules: [
      "Stop if spam submissions exceed 10% of total",
      "Stop if page engagement time drops by 25%",
      "Stop if call conversions on test pages drop by 30%",
    ],
    rollbackPlan: "Remove inline form module and restore 'Get a Free Estimate' link to /contact",
  },
  {
    name: "Landing Page Module Order Test",
    hypothesis: "Moving social proof (reviews) above the estimate form on install landing pages will increase FORM_SUBMIT by 20%+ in 2 weeks",
    successMetric: "form_submit_increase",
    minimumSampleSize: 150,
    durationWeeks: 2,
    conversionGoal: "FORM_SUBMIT" as ConversionGoal,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const installPages = snapshot?.topConversionPages
        ?.filter((p) => p.forms > 0).slice(0, 3).map((p) => p.url) || ["/services/heat-pump-installation"];
      return [
        {
          id: "control",
          name: "Form above reviews",
          description: "Current module order: hero → form → service details → reviews",
          config: { moduleOrder: ["hero", "form", "service_details", "reviews"], pages: installPages },
        },
        {
          id: "variant-a",
          name: "Reviews above form",
          description: "Reordered: hero → reviews (3 stars) → form → service details",
          config: { moduleOrder: ["hero", "reviews", "form", "service_details"], reviewCount: 3, pages: installPages },
        },
      ];
    },
    stopRules: [
      "Stop if page scroll depth decreases by 30%+",
      "Stop if FORM_SUBMIT drops below baseline for 4 consecutive days",
    ],
    rollbackPlan: "Restore original module order: hero → form → service details → reviews",
  },
  {
    name: "Ad Copy Estimate Intent Test",
    hypothesis: "Using 'Free Estimate' and pricing language in ad copy for install keywords will increase form conversions by 25%+ in 2 weeks",
    successMetric: "form_conversions_from_ads",
    minimumSampleSize: 200,
    durationWeeks: 2,
    conversionGoal: "FORM_SUBMIT" as ConversionGoal,
    makeVariants: (snapshot: MetricSnapshot | null): ExperimentVariant[] => {
      const installQueries = snapshot?.topQueries
        ?.filter((q) => q.query.includes("install")).slice(0, 5).map((q) => q.query) || ["heat pump installation denver"];
      return [
        {
          id: "control",
          name: "Generic install ad copy",
          description: "Current ad copy with standard sitelinks",
          config: { sitelinks: ["Services", "About Us", "Reviews"], keywords: installQueries },
        },
        {
          id: "variant-a",
          name: "Estimate-intent ad copy",
          description: "Ad copy with 'Free Estimate', pricing transparency, and form-focused landing page",
          config: { sitelinks: ["Free Estimate", "See Pricing", "Financing Available"], formLandingPage: true, keywords: installQueries },
        },
      ];
    },
    stopRules: [
      "Stop if CPC exceeds 2x baseline",
      "Stop if phone leads drop by 40%+ (over-optimizing for forms)",
    ],
    rollbackPlan: "Restore generic ad copy and standard sitelinks",
  },
];

// ============================================================
// Experiment Generator
// ============================================================

function makeExperimentId(type: string, name: string, week: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
  const input = `${type}:${slug}:w${week}`;
  return `exp-${type}-${deterministicHash(input).slice(0, 12)}-w${week}`;
}

function pickTemplate<T>(templates: T[], week: number): T {
  return templates[week % templates.length];
}

export function generateWeeklyExperiments(weekNumber?: number): ToolEnvelope<Experiment[]> {
  const week = weekNumber || currentWeekNumber();
  const snapshot = loadLatestSnapshot();
  const experiments: Experiment[] = [];

  // Pick one SEO experiment
  const seoTemplate = pickTemplate(SEO_TEMPLATES, week);
  experiments.push({
    id: makeExperimentId("seo", seoTemplate.name, week),
    type: "seo",
    name: seoTemplate.name,
    hypothesis: seoTemplate.hypothesis,
    variants: seoTemplate.makeVariants(snapshot),
    successMetric: seoTemplate.successMetric,
    minimumSampleSize: seoTemplate.minimumSampleSize,
    durationWeeks: seoTemplate.durationWeeks,
    stopRules: seoTemplate.stopRules,
    rollbackPlan: seoTemplate.rollbackPlan,
    status: "proposed",
    createdAt: nowISO(),
    weekNumber: week,
  });

  // Pick one Ads experiment
  const adsTemplate = pickTemplate(ADS_TEMPLATES, week);
  experiments.push({
    id: makeExperimentId("ads", adsTemplate.name, week),
    type: "ads",
    name: adsTemplate.name,
    hypothesis: adsTemplate.hypothesis,
    variants: adsTemplate.makeVariants(snapshot),
    successMetric: adsTemplate.successMetric,
    minimumSampleSize: adsTemplate.minimumSampleSize,
    durationWeeks: adsTemplate.durationWeeks,
    stopRules: adsTemplate.stopRules,
    rollbackPlan: adsTemplate.rollbackPlan,
    status: "proposed",
    createdAt: nowISO(),
    weekNumber: week,
  });

  // Pick one Call conversion experiment
  const callTemplate = pickTemplate(CALL_CONVERSION_TEMPLATES, week);
  experiments.push({
    id: makeExperimentId("conv-call", callTemplate.name, week),
    type: "conversion",
    name: callTemplate.name,
    hypothesis: callTemplate.hypothesis,
    variants: callTemplate.makeVariants(snapshot),
    successMetric: callTemplate.successMetric,
    minimumSampleSize: callTemplate.minimumSampleSize,
    durationWeeks: callTemplate.durationWeeks,
    stopRules: callTemplate.stopRules,
    rollbackPlan: callTemplate.rollbackPlan,
    status: "proposed",
    createdAt: nowISO(),
    weekNumber: week,
    conversionGoal: callTemplate.conversionGoal,
  });

  // Pick one Form conversion experiment
  const formTemplate = pickTemplate(FORM_CONVERSION_TEMPLATES, week);
  experiments.push({
    id: makeExperimentId("conv-form", formTemplate.name, week),
    type: "conversion",
    name: formTemplate.name,
    hypothesis: formTemplate.hypothesis,
    variants: formTemplate.makeVariants(snapshot),
    successMetric: formTemplate.successMetric,
    minimumSampleSize: formTemplate.minimumSampleSize,
    durationWeeks: formTemplate.durationWeeks,
    stopRules: formTemplate.stopRules,
    rollbackPlan: formTemplate.rollbackPlan,
    status: "proposed",
    createdAt: nowISO(),
    weekNumber: week,
    conversionGoal: formTemplate.conversionGoal,
  });

  return { status: "EXECUTED", data: experiments };
}

/**
 * Save experiments into a bundle's experiments/ directory.
 */
export function saveExperiments(bundleDir: string, experiments: Experiment[]): void {
  const dir = join(bundleDir, "experiments");
  ensureDir(dir);
  for (const exp of experiments) {
    writeJSON(join(dir, `${exp.id}.json`), exp);
  }
  writeJSON(join(dir, "experiments_index.json"), {
    count: experiments.length,
    ids: experiments.map((e) => e.id),
    createdAt: nowISO(),
  });
}

// Re-export for deterministic ID testing
export { makeExperimentId };
