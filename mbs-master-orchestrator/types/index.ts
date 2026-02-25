// ============================================================
// MBS Master Orchestrator — Core Type Definitions
// Schema Version: 1.0.0
// ============================================================

// ---- Tool Envelope (MBS-style) ----

export type ToolStatus = "EXECUTED" | "BLOCKED" | "FAILED" | "NEEDS_APPROVAL";

export interface ToolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ToolEnvelope<T = unknown> {
  status: ToolStatus;
  data?: T;
  error?: ToolError;
}

// ---- Tool Registry ----

export interface ToolDefinition {
  id: string;
  name: string;
  version: string;
  description: string;
  category: "planner" | "runner" | "assembler" | "approvals" | "report" | "validator" | "export" | "conversion" | "leads" | "seasonality" | "waste";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requiresApproval: boolean;
  sideEffects: boolean;
}

// ---- Operator Config ----

export interface OperatorConfig {
  name: string;
  repoPath: string;
  cli: string;
  intents: string[];
  enabled: boolean;
  timeoutSeconds: number;
  packGlob: string;
}

export interface OrchestratorConfig {
  version: string;
  operators: OperatorConfig[];
  bundleRetentionDays: number;
  defaultWeekStart: "monday" | "sunday";
}

// ---- KPI Targets ----

export interface KPITargets {
  indexedPages: { current: number; target: number; deadline: string };
  weeklyGBPPosts: { current: number; target: number };
  monthlyAdCampaigns: { current: number; target: number };
  weeklyBlogPosts: { current: number; target: number };
  reviewVelocity: { current: number; target: number; unit: string };
  monthlyLeads: { current: number; target: number };
}

// ---- Learned Config ----

export interface OrchestratorLearned {
  lastUpdated: string;
  preferredIntentOrder: string[];
  skipReasons: Record<string, string>;
  adjustments: Record<string, unknown>;
}

// ---- Operator Execution ----

export interface OperatorCommand {
  operator: string;
  command: string;
  args: string[];
  cwd: string;
}

export interface OperatorExecResult {
  operator: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  timedOut: boolean;
}

// ---- Approval Types ----

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalItem {
  itemId: string;
  type: string;
  description: string;
  status: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
  notes?: string;
}

export interface OperatorApprovalFile {
  packId: string;
  overallStatus: ApprovalStatus;
  items: ApprovalItem[];
  createdAt: string;
  lastUpdated: string;
}

export interface ApprovalsSummary {
  timestamp: string;
  operators: {
    name: string;
    packs: {
      packId: string;
      packPath: string;
      overallStatus: ApprovalStatus;
      totalItems: number;
      approved: number;
      pending: number;
      rejected: number;
      hashIntegrity?: "valid" | "invalid" | "unchecked";
    }[];
  }[];
  blockedReasons: { operator: string; packId: string; reason: string }[];
  allApproved: boolean;
}

// ---- Bundle Manifest ----

export interface BundleManifest {
  bundleId: string;
  weekNumber: number;
  createdAt: string;
  deterministicHash: string;
  generatorVersion: string;
  schemaVersion: "1.0.0";
  operators: {
    name: string;
    packIds: string[];
    packPaths: string[];
    checksOverall: { passed: boolean; score: number };
    approvalStatus: ApprovalStatus;
  }[];
  kpiSnapshot: Partial<KPITargets>;
  experiments?: Experiment[];
  requiresApproval: boolean;
}

// ---- Bundle Checks ----

export interface BundleCheckResult {
  passed: boolean;
  score: number;
  issues: { code: string; severity: "error" | "warning" | "info"; message: string; suggestion?: string }[];
}

export interface BundleChecks {
  bundleId: string;
  timestamp: string;
  validators: Record<string, BundleCheckResult>;
  overallPassed: boolean;
  overallScore: number;
}

// ---- Planning ----

export interface PlanIntent {
  id: string;
  operator: string;
  command: string;
  args: string[];
  reason: string;
  priority: "high" | "medium" | "low";
  kpiDriver?: string;
  expectedCalls?: number;
  expectedForms?: number;
  expectedConversionValue?: number;
  zip?: string;
  geoTier?: GeoTierName | "unknown";
  geoAdjustedScore?: number;
  profitEfficiencyScore?: number;
}

export interface WeeklyPlan {
  planId: string;
  weekNumber: number;
  createdAt: string;
  intents: PlanIntent[];
  seasonBlocked?: { id: string; reason: string }[];
  seasonMode?: SeasonMode;
  conservativeBlocked?: { id: string; reason: string }[];
  operatingMode?: OperatingMode;
  flowBlocked?: { id: string; reason: string }[];
  flowReprioritized?: { id: string; reason: string }[];
}

// ---- Metrics ----

export type ConversionGoal = "CALL_CLICK" | "FORM_SUBMIT";

export interface ConversionConfig {
  primaryGoals: ConversionGoal[];
  weights: Record<ConversionGoal, number>;
  tieBreakerWindowDays: number;
  callCloseRate?: number;
  formCloseRate?: number;
  avgTicketCall?: number;
  avgTicketForm?: number;
  targetCPL?: number;
}

// ---- Geo Priority ----

export type GeoTierName = "tier1_core" | "tier2_upgrade" | "tier3_selective" | "tier4_boulder_reduced";

export interface GeoTier {
  weightRange: string;
  zips: Record<string, number>;
}

export interface GeoLearningConfig {
  enabled: boolean;
  mode: "CONSERVATIVE" | "BALANCED";
  minDataWindowDays: number;
  minLeadsPerZip: number;
  maxWeight: number;
  minWeight: number;
  stepUp: number;
  stepDown: number;
}

export interface GeoPriorityConfig {
  baseZip: string;
  maxRadiusMiles: number;
  tiers?: Record<GeoTierName, GeoTier>;
  bidModifiers?: Record<string, number>;
  excludedCounties?: string[];
  zipWeights?: Record<string, number>;
  learning?: GeoLearningConfig;
}

export interface ZipPerformance {
  zip: string;
  leads: number;
  calls: number;
  forms: number;
  spend: number;
  cpl: number;
  weightedLeadValue: number;
  profitEfficiency: number;
  currentWeight: number;
}

export interface ZipWeightProposal {
  zip: string;
  currentWeight: number;
  proposedWeight: number;
  delta: number;
  reason: string;
  leads: number;
  cpl: number;
  profitEfficiency: number;
}

export interface GeoLearnerOutput {
  timestamp: string;
  mode: string;
  zipsEvaluated: number;
  proposals: ZipWeightProposal[];
  insufficientData: string[];
  topPerformers: ZipPerformance[];
  summary: {
    increases: number;
    decreases: number;
    holds: number;
    insufficientData: number;
  };
}

// ---- Efficiency Guard ----

export interface EfficiencyInput {
  zip: string;
  costPerWeightedLead: number;
  impressionShareLostToBudget: number;
  travelDistanceMiles: number;
  currentBidModifier: number;
}

export interface EfficiencyRecommendation {
  zip: string;
  tier: GeoTierName | "unknown";
  action: "reduce_bid" | "increase_bid" | "suppress" | "hold";
  currentBidModifier: number;
  recommendedBidModifier: number;
  reason: string;
  costPerWeightedLead: number;
  travelDistanceMiles: number;
}

export interface EfficiencyGuardOutput {
  timestamp: string;
  targetCPL: number;
  recommendations: EfficiencyRecommendation[];
  suppressedZips: { zip: string; reason: string }[];
  summary: {
    totalZipsEvaluated: number;
    bidIncreases: number;
    bidDecreases: number;
    suppressions: number;
    holds: number;
  };
}

// ---- Profit Efficiency ----

export interface ProfitScore {
  weightedLeadValue: number;
  adSpend: number;
  profitEfficiencyScore: number;
  roi: number;
}

export interface GA4EventRow {
  page: string;
  eventName: string;
  eventCount: number;
}

export interface ConversionPageRow {
  url: string;
  calls: number;
  forms: number;
  weightedValue: number;
}

export interface GSCPageRow {
  page: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

export interface GSCQueryRow {
  query: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

export interface MetricSnapshot {
  date: string;
  source: "gsc" | "manual" | "combined";
  indexedPages?: number;
  topPages: GSCPageRow[];
  topQueries: GSCQueryRow[];
  totals: {
    impressions: number;
    clicks: number;
    ctr: number;
    avgPosition: number;
  };
  conversions?: {
    CALL_CLICK?: number;
    FORM_SUBMIT?: number;
    weightedTotal?: number;
  };
  topConversionPages?: ConversionPageRow[];
}

// ---- Experiments ----

export interface ExperimentVariant {
  id: string;
  name: string;
  description: string;
  config: Record<string, unknown>;
}

export interface Experiment {
  id: string;
  type: "seo" | "ads" | "conversion";
  name: string;
  hypothesis: string;
  variants: ExperimentVariant[];
  successMetric: string;
  minimumSampleSize: number;
  durationWeeks: number;
  stopRules: string[];
  rollbackPlan: string;
  status: "proposed" | "approved" | "running" | "completed" | "rolled_back";
  createdAt: string;
  weekNumber: number;
  conversionGoal?: ConversionGoal;
}

// ---- Report ----

export interface MasterReport {
  reportId: string;
  weekNumber: number;
  createdAt: string;
  kpiSnapshot: Partial<KPITargets>;
  metricSnapshot?: MetricSnapshot | null;
  operatorSummaries: {
    name: string;
    packsGenerated: number;
    validationScore: number;
    approvalStatus: ApprovalStatus;
    issues: number;
  }[];
  experiments: Experiment[];
  nextActions: string[];
  blockedItems: string[];
  approvalIntegrityIssues: string[];
  conversionSnapshot?: {
    calls: number;
    forms: number;
    weightedTotal: number;
    callDrivers: ConversionPageRow[];
    formDrivers: ConversionPageRow[];
  };
  geoDistribution?: {
    tier1_core: number;
    tier2_upgrade: number;
    tier3_selective: number;
    tier4_boulder_reduced: number;
  };
  efficiencyRecommendations?: EfficiencyRecommendation[];
  suppressedZips?: { zip: string; reason: string }[];
  topProfitZips?: { zip: string; tier: string; profitEfficiency: number; weightedLeadValue: number }[];
  seasonMode?: { season: SeasonMode; month: number; blockedIntents: string[] };
  calibrationDeltas?: { metric: string; modeled: number; observed: number; delta: number }[];
  wasteHunterSummary?: { totalTerms: number; negativeRecs: number; matchTypeTightens: number; wastedSpend: number };
  conservativeMode?: {
    mode: OperatingMode;
    capacityStatus: { backlogHours: number; maxHours: number; available: boolean };
    blockedScaleEvents: number;
    pullbackTriggers: number;
    travelInefficiencies: number;
    tier2Allowed: boolean;
    tier4Allowed: boolean;
    expansionBlockReason?: string;
  };
  flowGovernor?: {
    leadsToday: number;
    leadsCap: number;
    installWeek: number;
    installCap: number;
    repairToday: number;
    repairCap: number;
    upgradeRatio: number;
    upgradeMin: number;
    backlogHours: number;
    backlogBuffer: number;
    decisions: FlowGovernorDecision[];
    suppressedCount: number;
    reprioritizedCount: number;
    boostedCount: number;
    flowMode?: FlowMode;
    effectiveLeads?: number;
    rawLeads?: number;
    hardCap?: number;
    softCap?: number;
    overflowCap?: number;
    lowTicketRepairShare?: number;
    maxLowTicketRepairShare?: number;
  };
  geoLearning?: {
    mode: string;
    zipsEvaluated: number;
    increases: number;
    decreases: number;
    holds: number;
    insufficientData: number;
    topPerformers: { zip: string; cpl: number; profitEfficiency: number; currentWeight: number; proposedWeight: number }[];
    proposals: ZipWeightProposal[];
  };
}

// ---- Lead Quality ----

export interface LeadQualityConfig {
  call: {
    durationThresholdSec: number;
    peakHoursBonus: number;
    repeatCallerPenalty: number;
    weights: { duration: number; peakHour: number; serviceMatch: number };
  };
  form: {
    requiredFields: string[];
    bonusFields: string[];
    weights: { fieldCompleteness: number; serviceSpecificity: number; urgencySignal: number };
    urgencyKeywords: string[];
  };
  qualityThreshold: number;
}

export interface LeadQualityScore {
  leadType: "call" | "form";
  rawScore: number;
  qualityMultiplier: number;
  qualified: boolean;
  signals: string[];
}

// ---- Outcome Calibration ----

export interface OutcomeRow {
  leadType: "call" | "form";
  qualified: boolean;
  sold: boolean;
  revenue: number;
}

export interface CalibrationResult {
  callCloseRate: { modeled: number; observed: number; delta: number };
  formCloseRate: { modeled: number; observed: number; delta: number };
  avgTicketCall: { modeled: number; observed: number; delta: number };
  avgTicketForm: { modeled: number; observed: number; delta: number };
  sampleSize: { calls: number; forms: number };
  proposedUpdates: Partial<ConversionConfig>;
  confidence: "low" | "medium" | "high";
}

// ---- Seasonality ----

export type SeasonMode = "HEATING" | "COOLING" | "SHOULDER";

export interface SeasonRule {
  months: number[];
  allowedServices: string[];
  blockedPatterns: string[];
  mode: SeasonMode;
}

export interface SeasonGateResult {
  currentSeason: SeasonMode;
  month: number;
  allowed: boolean;
  blockedReason?: string;
}

// ---- Waste Hunter ----

export interface SearchTermRow {
  searchTerm: string;
  campaign?: string;
  adGroup?: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
}

// ---- Conservative Mode ----

export type OperatingMode = "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";

export interface ModeConfig {
  mode: OperatingMode;
  scaleThresholdMultiplier: number;
  pullbackThresholdMultiplier: number;
  travelDistanceLimitMiles: number;
  boulderDistanceLimitMiles: number;
  tier1ExpansionThreshold: number;
  wasteSpendThreshold: number;
}

export interface CapacityConfig {
  maxBacklogHours: number;
  techCapacity: number;
  currentBacklogHours: number;
}

export interface ConservativeGuardInput extends EfficiencyInput {
  qualifiedLeadScore?: number;
  closeRateDrop?: number;
  profitEfficiencyScore?: number;
  wasteSpendRatio?: number;
}

export interface ConservativeGuardResult {
  zip: string;
  tier: GeoTierName | "unknown";
  action: "scale" | "pullback" | "suppress" | "hold" | "block_capacity";
  currentBidModifier: number;
  recommendedBidModifier: number;
  reason: string;
  triggers: string[];
}

export interface ConservativeGuardOutput {
  timestamp: string;
  mode: OperatingMode;
  targetCPL: number;
  capacityStatus: { backlogHours: number; maxHours: number; available: boolean };
  results: ConservativeGuardResult[];
  blockedScaleEvents: ConservativeGuardResult[];
  pullbackTriggers: ConservativeGuardResult[];
  travelInefficiencies: ConservativeGuardResult[];
  summary: {
    totalEvaluated: number;
    scaleAllowed: number;
    scaleBlocked: number;
    pullbacks: number;
    suppressions: number;
    holds: number;
    capacityBlocks: number;
  };
}

export interface TierExpansionCheck {
  tier2Allowed: boolean;
  tier4Allowed: boolean;
  blockedReason?: string;
  tier1Saturation: number;
  tier1CPLBelowTarget: boolean;
  capacityAvailable: boolean;
  tier1PlusTier2Profitable: boolean;
  profitMarginAboveThreshold: boolean;
}

export interface WasteTermRecommendation {
  term: string;
  reason: "high_spend_zero_conv" | "irrelevant" | "low_relevance";
  action: "add_negative" | "tighten_match";
  matchType?: "exact" | "phrase";
  spend: number;
  clicks: number;
  conversions: number;
  category?: string;
}

export interface WasteHunterOutput {
  timestamp: string;
  totalTermsAnalyzed: number;
  negativeRecommendations: WasteTermRecommendation[];
  matchTypeTightenings: WasteTermRecommendation[];
  summary: {
    totalWastedSpend: number;
    highSpendZeroConv: number;
    irrelevantTerms: number;
    tightenSuggestions: number;
  };
}

// ---- Lead Flow Governor ----

export type FlowMode = "NORMAL" | "WAITLIST" | "THROTTLE" | "SUPPRESS";

export interface FlowControlConfig {
  maxQualifiedLeadsPerDay: number;
  hardCapQualifiedLeadsPerDay?: number;
  softCapMultiplier?: number;
  overflowMultiplier?: number;
  maxInstallLeadsPerWeek: number;
  maxRepairLeadsPerDay: number;
  minUpgradeRatio: number;
  backlogBufferHours: number;
  maxLowTicketRepairShare?: number;
  qualityDiscountEnabled?: boolean;
}

export interface FlowState {
  qualifiedLeadsToday: number;
  installLeadsThisWeek: number;
  repairLeadsToday: number;
  upgradeLeadsThisWeek: number;
  totalLeadsThisWeek: number;
  backlogHours: number;
  qualifiedLeadScoreToday?: number;
  junkLeadRateEstimate?: number;
  lowTicketRepairShareToday?: number;
}

export type FlowAction =
  | "block_bid_increase"
  | "suppress_tier2"
  | "pause_install_ads"
  | "reduce_repair_bids"
  | "boost_upgrade_priority"
  | "reduce_geo_radius"
  | "suppress_tier2_tier3"
  | "tighten_match_types"
  | "reduce_bids_10"
  | "suppress_non_tier1"
  | "reduce_bids_15"
  | "restrict_install_tier1"
  | "reduce_install_bids_15"
  | "demote_low_ticket_repair"
  | "promote_upgrade_install";

export interface FlowGovernorDecision {
  action: FlowAction;
  reason: string;
  severity: "info" | "warning" | "critical";
}

export interface FlowGovernorResult {
  timestamp: string;
  state: FlowState;
  config: FlowControlConfig;
  decisions: FlowGovernorDecision[];
  intentModifications: {
    suppressed: string[];
    reprioritized: string[];
    boosted: string[];
  };
  summary: {
    leadsVsCap: { today: number; cap: number; pct: number };
    installVsCap: { week: number; cap: number; pct: number };
    repairVsCap: { today: number; cap: number; pct: number };
    upgradeRatio: { current: number; min: number; met: boolean };
    backlogStatus: { hours: number; buffer: number; overloaded: boolean };
    totalSuppressed: number;
    totalReprioritized: number;
    totalBoosted: number;
    flowMode?: FlowMode;
    effectiveLeads?: number;
    rawLeads?: number;
    hardCap?: number;
    softCap?: number;
    overflowCap?: number;
  };
}
