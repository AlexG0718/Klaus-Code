/**
 * Dynamic token budget management with escalation tiers.
 *
 * Sessions start at the baseline tier and escalate only when genuine
 * complexity signals are detected:
 *   - Repeated test failures (run_tests fails 2+ times consecutively)
 *   - Scope expansion (5+ unique files modified, or 3x initial file count)
 *
 * Escalation is one-directional — a session never de-escalates.
 *
 * When all tier values are 0 (the default), the manager operates in legacy
 * flat-budget mode using the single AGENT_TOKEN_BUDGET value.
 */

export enum BudgetTier {
  TIER1_BASELINE = 1,
  TIER2_ESCALATION = 2,
  TIER3_HARD_CAP = 3,
}

export interface EscalationSignals {
  /** Number of consecutive test failures (reset on pass) */
  consecutiveTestFailures: number;
  /** Set of unique file paths modified via write_file / apply_patch */
  filesModified: Set<string>;
  /** Number of unique files at the time the initial scope was recorded */
  initialFileScope: number;
  /** Whether the initial scope has been recorded yet */
  initialScopeRecorded: boolean;
}

export interface BudgetCheckResult {
  halt: boolean;
  warning: boolean;
  escalated: boolean;
  newTier?: BudgetTier;
}

export interface TokenBudgetManagerConfig {
  flatBudget: number; // AGENT_TOKEN_BUDGET (legacy)
  tier1: number;      // AGENT_TOKEN_BUDGET_TIER1
  tier2: number;      // AGENT_TOKEN_BUDGET_TIER2
  tier3: number;      // AGENT_TOKEN_BUDGET_TIER3
}

export class TokenBudgetManager {
  private readonly tiered: boolean;
  private readonly tier1Budget: number;
  private readonly tier2Budget: number;
  private readonly tier3Budget: number;
  private currentTier: BudgetTier;
  private activeBudget: number;
  private budgetWarningFired = false;

  readonly signals: EscalationSignals = {
    consecutiveTestFailures: 0,
    filesModified: new Set(),
    initialFileScope: 0,
    initialScopeRecorded: false,
  };

  // ── Escalation thresholds ──────────────────────────────────────────────
  static readonly TEST_FAILURE_THRESHOLD = 2;
  static readonly SCOPE_EXPANSION_THRESHOLD = 5;
  static readonly SCOPE_GROWTH_FACTOR = 3;

  constructor(config: TokenBudgetManagerConfig) {
    this.tiered = config.tier1 > 0 && config.tier2 > 0 && config.tier3 > 0;

    if (this.tiered) {
      this.tier1Budget = config.tier1;
      this.tier2Budget = config.tier2;
      this.tier3Budget = config.tier3;
      this.currentTier = BudgetTier.TIER1_BASELINE;
      this.activeBudget = this.tier1Budget;
    } else {
      // Legacy flat-budget mode
      this.tier1Budget = config.flatBudget;
      this.tier2Budget = config.flatBudget;
      this.tier3Budget = config.flatBudget;
      this.currentTier = BudgetTier.TIER3_HARD_CAP; // no escalation possible
      this.activeBudget = config.flatBudget;
    }
  }

  /** Currently active token budget */
  get budget(): number {
    return this.activeBudget;
  }

  /** Current tier */
  get tier(): BudgetTier {
    return this.currentTier;
  }

  /** Whether tiered mode is active (vs legacy flat mode) */
  get isTiered(): boolean {
    return this.tiered;
  }

  /**
   * Record a test result. Returns true if escalation was triggered.
   */
  recordTestResult(passed: boolean): boolean {
    if (!this.tiered) return false;

    if (passed) {
      this.signals.consecutiveTestFailures = 0;
      return false;
    }

    this.signals.consecutiveTestFailures++;
    return this.tryEscalate();
  }

  /**
   * Record a file modification. Returns true if escalation was triggered.
   */
  recordFileModification(filePath: string): boolean {
    if (!this.tiered) return false;

    const prevSize = this.signals.filesModified.size;
    this.signals.filesModified.add(filePath);

    // Duplicate — no new signal
    if (this.signals.filesModified.size === prevSize) return false;

    // Record initial scope after the 2nd unique file
    if (!this.signals.initialScopeRecorded && this.signals.filesModified.size >= 2) {
      this.signals.initialFileScope = this.signals.filesModified.size;
      this.signals.initialScopeRecorded = true;
    }

    return this.tryEscalate();
  }

  /**
   * Check budget against the current active tier.
   * Attempts escalation before halting — if the agent has earned more
   * budget via complexity signals, it gets it.
   */
  checkBudget(totalUsed: number): BudgetCheckResult {
    const budget = this.activeBudget;
    if (budget <= 0) return { halt: false, warning: false, escalated: false };

    const pct = totalUsed / budget;

    // Budget exhausted — try to escalate before halting
    if (totalUsed >= budget) {
      const escalated = this.tryEscalate();
      if (escalated) {
        // Re-check with new budget
        const newPct = totalUsed / this.activeBudget;
        const warning = !this.budgetWarningFired && newPct >= 0.8 && newPct < 1.0;
        if (warning) this.budgetWarningFired = true;
        return { halt: false, warning, escalated: true, newTier: this.currentTier };
      }
      return { halt: true, warning: false, escalated: false };
    }

    // Approaching limit — warn and try proactive escalation
    const warning = !this.budgetWarningFired && pct >= 0.8;
    if (warning) this.budgetWarningFired = true;

    if (pct >= 0.8) {
      const escalated = this.tryEscalate();
      if (escalated) {
        this.budgetWarningFired = false; // Reset for new tier
        return { halt: false, warning: false, escalated: true, newTier: this.currentTier };
      }
    }

    return { halt: false, warning, escalated: false };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Attempt to escalate to the next tier. Returns true if escalation occurred.
   */
  private tryEscalate(): boolean {
    if (!this.tiered) return false;
    if (!this.shouldEscalate()) return false;

    const prevTier = this.currentTier;

    if (this.currentTier === BudgetTier.TIER1_BASELINE) {
      this.currentTier = BudgetTier.TIER2_ESCALATION;
      this.activeBudget = this.tier2Budget;
    } else if (this.currentTier === BudgetTier.TIER2_ESCALATION) {
      this.currentTier = BudgetTier.TIER3_HARD_CAP;
      this.activeBudget = this.tier3Budget;
    }

    if (this.currentTier !== prevTier) {
      this.budgetWarningFired = false; // Reset for new tier ceiling
      // Reset the failure counter so the same signal doesn't cascade
      // (e.g., 2 failures trigger Tier1→Tier2, but should not immediately
      // trigger Tier2→Tier3 without new failures)
      this.signals.consecutiveTestFailures = 0;
      return true;
    }

    return false;
  }

  /**
   * Evaluate whether current signals warrant escalation.
   */
  private shouldEscalate(): boolean {
    if (this.currentTier >= BudgetTier.TIER3_HARD_CAP) return false;

    // Signal 1: Repeated test failures
    if (
      this.signals.consecutiveTestFailures >=
      TokenBudgetManager.TEST_FAILURE_THRESHOLD
    ) {
      return true;
    }

    // Signal 2: Absolute scope expansion
    const fileCount = this.signals.filesModified.size;
    if (fileCount >= TokenBudgetManager.SCOPE_EXPANSION_THRESHOLD) {
      if (this.currentTier === BudgetTier.TIER1_BASELINE) return true;
      // Tier2 → Tier3 requires significantly more files
      if (fileCount >= TokenBudgetManager.SCOPE_EXPANSION_THRESHOLD * 2) return true;
    }

    // Signal 3: Relative scope growth (3x the initial expectation)
    if (this.signals.initialScopeRecorded && this.signals.initialFileScope > 0) {
      const growth = fileCount / this.signals.initialFileScope;
      if (growth >= TokenBudgetManager.SCOPE_GROWTH_FACTOR) return true;
    }

    return false;
  }
}
