/**
 * Tests for TokenBudgetManager — dynamic token budget with escalation tiers.
 *
 * Covers:
 *   - Legacy flat-budget mode (all tier vars = 0)
 *   - Tiered mode — baseline, escalation, hard cap
 *   - Escalation via test failures
 *   - Escalation via scope expansion (absolute + relative)
 *   - Budget check with automatic escalation
 *   - Multi-turn simulations
 *   - Edge cases
 */

import {
  TokenBudgetManager,
  BudgetTier,
} from '../../agent/TokenBudgetManager';
import type { TokenBudgetManagerConfig } from '../../agent/TokenBudgetManager';

// ── Helpers ──────────────────────────────────────────────────────────────────

function flatConfig(budget = 100_000): TokenBudgetManagerConfig {
  return { flatBudget: budget, tier1: 0, tier2: 0, tier3: 0 };
}

function tieredConfig(
  tier1 = 25_000,
  tier2 = 50_000,
  tier3 = 100_000
): TokenBudgetManagerConfig {
  return { flatBudget: 100_000, tier1, tier2, tier3 };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TokenBudgetManager', () => {
  // ── Legacy flat-budget mode ──────────────────────────────────────────────

  describe('flat mode (all tier vars = 0)', () => {
    it('uses flatBudget as the active budget', () => {
      const m = new TokenBudgetManager(flatConfig(100_000));
      expect(m.budget).toBe(100_000);
      expect(m.isTiered).toBe(false);
    });

    it('warns at 80% and halts at 100%', () => {
      const m = new TokenBudgetManager(flatConfig(100_000));

      const r1 = m.checkBudget(80_000);
      expect(r1.warning).toBe(true);
      expect(r1.halt).toBe(false);
      expect(r1.escalated).toBe(false);

      const r2 = m.checkBudget(100_000);
      expect(r2.halt).toBe(true);
      expect(r2.escalated).toBe(false);
    });

    it('warning fires only once', () => {
      const m = new TokenBudgetManager(flatConfig(100_000));

      m.checkBudget(80_000); // fires warning
      const r = m.checkBudget(90_000); // should not fire again
      expect(r.warning).toBe(false);
    });

    it('budget of 0 means unlimited', () => {
      const m = new TokenBudgetManager(flatConfig(0));
      const r = m.checkBudget(10_000_000);
      expect(r.halt).toBe(false);
      expect(r.warning).toBe(false);
    });

    it('recordTestResult never escalates in flat mode', () => {
      const m = new TokenBudgetManager(flatConfig());
      expect(m.recordTestResult(false)).toBe(false);
      expect(m.recordTestResult(false)).toBe(false);
      expect(m.recordTestResult(false)).toBe(false);
    });

    it('recordFileModification never escalates in flat mode', () => {
      const m = new TokenBudgetManager(flatConfig());
      for (let i = 0; i < 20; i++) {
        expect(m.recordFileModification(`file${i}.ts`)).toBe(false);
      }
    });
  });

  // ── Tiered mode — basic ──────────────────────────────────────────────────

  describe('tiered mode — basic behavior', () => {
    it('starts at TIER1_BASELINE with tier1 budget', () => {
      const m = new TokenBudgetManager(tieredConfig());
      expect(m.tier).toBe(BudgetTier.TIER1_BASELINE);
      expect(m.budget).toBe(25_000);
      expect(m.isTiered).toBe(true);
    });

    it('warns at 80% of tier1 budget', () => {
      const m = new TokenBudgetManager(tieredConfig());
      const r = m.checkBudget(20_000); // 80% of 25K
      expect(r.warning).toBe(true);
    });

    it('halts at 100% of tier1 if no escalation signals', () => {
      const m = new TokenBudgetManager(tieredConfig());
      const r = m.checkBudget(25_000);
      expect(r.halt).toBe(true);
      expect(r.escalated).toBe(false);
    });
  });

  // ── Escalation via test failures ─────────────────────────────────────────

  describe('escalation via test failures', () => {
    it('single failure does NOT trigger escalation', () => {
      const m = new TokenBudgetManager(tieredConfig());
      const escalated = m.recordTestResult(false);
      expect(escalated).toBe(false);
      expect(m.tier).toBe(BudgetTier.TIER1_BASELINE);
    });

    it('2 consecutive failures escalate Tier1 → Tier2', () => {
      const m = new TokenBudgetManager(tieredConfig());
      m.recordTestResult(false);
      const escalated = m.recordTestResult(false);
      expect(escalated).toBe(true);
      expect(m.tier).toBe(BudgetTier.TIER2_ESCALATION);
      expect(m.budget).toBe(50_000);
    });

    it('passing test resets the consecutive failure counter', () => {
      const m = new TokenBudgetManager(tieredConfig());
      m.recordTestResult(false);
      m.recordTestResult(true); // reset
      const escalated = m.recordTestResult(false); // only 1 failure after reset
      expect(escalated).toBe(false);
      expect(m.tier).toBe(BudgetTier.TIER1_BASELINE);
    });

    it('fail-pass-fail does NOT escalate', () => {
      const m = new TokenBudgetManager(tieredConfig());
      m.recordTestResult(false);
      m.recordTestResult(true);
      m.recordTestResult(false);
      expect(m.tier).toBe(BudgetTier.TIER1_BASELINE);
    });

    it('at Tier2, 2 more consecutive failures escalate to Tier3', () => {
      const m = new TokenBudgetManager(tieredConfig());
      // Escalate to Tier2
      m.recordTestResult(false);
      m.recordTestResult(false);
      expect(m.tier).toBe(BudgetTier.TIER2_ESCALATION);

      // Reset and fail again
      m.recordTestResult(true); // reset counter
      m.recordTestResult(false);
      m.recordTestResult(false);
      expect(m.tier).toBe(BudgetTier.TIER3_HARD_CAP);
      expect(m.budget).toBe(100_000);
    });

    it('at Tier3, test failures do not escalate further', () => {
      const m = new TokenBudgetManager(tieredConfig());
      // Force to Tier3
      m.recordTestResult(false);
      m.recordTestResult(false); // → Tier2
      m.recordTestResult(false);
      m.recordTestResult(false); // → Tier3

      const escalated = m.recordTestResult(false);
      expect(escalated).toBe(false);
      expect(m.tier).toBe(BudgetTier.TIER3_HARD_CAP);
    });
  });

  // ── Escalation via scope expansion ───────────────────────────────────────

  describe('escalation via scope expansion (absolute)', () => {
    it('4 files does NOT trigger escalation from Tier1', () => {
      const m = new TokenBudgetManager(tieredConfig());
      for (let i = 0; i < 4; i++) m.recordFileModification(`file${i}.ts`);
      expect(m.tier).toBe(BudgetTier.TIER1_BASELINE);
    });

    it('5 unique files triggers Tier1 → Tier2', () => {
      const m = new TokenBudgetManager(tieredConfig());
      for (let i = 0; i < 5; i++) m.recordFileModification(`file${i}.ts`);
      expect(m.tier).toBe(BudgetTier.TIER2_ESCALATION);
      expect(m.budget).toBe(50_000);
    });

    it('duplicate file paths are deduplicated', () => {
      const m = new TokenBudgetManager(tieredConfig());
      for (let i = 0; i < 10; i++) m.recordFileModification('same-file.ts');
      expect(m.tier).toBe(BudgetTier.TIER1_BASELINE);
      expect(m.signals.filesModified.size).toBe(1);
    });

    it('at Tier2, 10 unique files triggers Tier2 → Tier3', () => {
      const m = new TokenBudgetManager(tieredConfig());
      // Get to Tier2
      for (let i = 0; i < 5; i++) m.recordFileModification(`file${i}.ts`);
      expect(m.tier).toBe(BudgetTier.TIER2_ESCALATION);

      // Add more files to reach 10
      for (let i = 5; i < 10; i++) m.recordFileModification(`file${i}.ts`);
      expect(m.tier).toBe(BudgetTier.TIER3_HARD_CAP);
    });
  });

  // ── Escalation via relative scope growth ─────────────────────────────────

  describe('escalation via scope growth (relative)', () => {
    it('3x initial scope triggers escalation', () => {
      const m = new TokenBudgetManager(tieredConfig());
      // 2 files → records initial scope of 2
      m.recordFileModification('a.ts');
      m.recordFileModification('b.ts');
      expect(m.signals.initialScopeRecorded).toBe(true);
      expect(m.signals.initialFileScope).toBe(2);

      // 3rd and 4th files: total = 4, growth = 2x — not enough
      m.recordFileModification('c.ts');
      m.recordFileModification('d.ts');
      expect(m.tier).toBe(BudgetTier.TIER1_BASELINE);

      // 5th file: absolute threshold (5) hit → Tier1 → Tier2
      const escalated5 = m.recordFileModification('e.ts');
      expect(escalated5).toBe(true);
      expect(m.tier).toBe(BudgetTier.TIER2_ESCALATION);

      // 6th file: growth = 6/2 = 3x → Tier2 → Tier3
      const escalated6 = m.recordFileModification('f.ts');
      expect(escalated6).toBe(true);
      expect(m.tier).toBe(BudgetTier.TIER3_HARD_CAP);
    });

    it('1.67x initial scope does NOT trigger escalation', () => {
      const m = new TokenBudgetManager(tieredConfig());
      m.recordFileModification('a.ts');
      m.recordFileModification('b.ts');
      m.recordFileModification('c.ts'); // initial scope = 3 (recorded at 2nd file)
      // scope = 3, initial = 2, growth = 1.5x — not enough
      expect(m.tier).toBe(BudgetTier.TIER1_BASELINE);

      m.recordFileModification('d.ts'); // scope = 4, growth = 2x — still not enough
      expect(m.tier).toBe(BudgetTier.TIER1_BASELINE);
    });

    it('initial scope recording happens at 2nd unique file', () => {
      const m = new TokenBudgetManager(tieredConfig());
      m.recordFileModification('first.ts');
      expect(m.signals.initialScopeRecorded).toBe(false);

      m.recordFileModification('second.ts');
      expect(m.signals.initialScopeRecorded).toBe(true);
      expect(m.signals.initialFileScope).toBe(2);
    });
  });

  // ── Budget check with escalation ─────────────────────────────────────────

  describe('checkBudget with automatic escalation', () => {
    it('at 100% of tier1 with signals: escalates instead of halting', () => {
      const m = new TokenBudgetManager(tieredConfig());
      // Create escalation signal (2 test failures)
      m.recordTestResult(false);
      m.recordTestResult(false); // → Tier2 already from signal

      // Now budget check at the old tier1 budget
      const r = m.checkBudget(25_000);
      expect(r.halt).toBe(false);
      expect(m.budget).toBe(50_000);
    });

    it('proactive escalation at 80% when signals are present', () => {
      const m = new TokenBudgetManager(tieredConfig());
      // Add test failures but not enough to auto-escalate via signal
      m.recordTestResult(false);
      // Add 5 files to trigger scope expansion
      for (let i = 0; i < 5; i++) m.recordFileModification(`f${i}.ts`);
      // Already escalated to Tier2 via scope

      // Budget at 80% of tier2 — should try proactive escalation
      // No further signals for Tier3 yet (need 10 files)
      const r = m.checkBudget(40_000);
      expect(r.warning).toBe(true); // 80% warning fires
    });

    it('after escalation, warning can fire again for new tier', () => {
      const m = new TokenBudgetManager(tieredConfig());
      // Trigger 80% warning at Tier1
      m.checkBudget(20_000); // 80% of 25K — warning fires

      // Escalate to Tier2 via test failures
      m.recordTestResult(false);
      m.recordTestResult(false);
      expect(m.tier).toBe(BudgetTier.TIER2_ESCALATION);

      // 80% of 50K = 40K — warning should fire again
      const r = m.checkBudget(40_000);
      expect(r.warning).toBe(true);
    });

    it('at Tier3 with totalUsed >= tier3Budget: halts', () => {
      const m = new TokenBudgetManager(tieredConfig());
      // Force to Tier3
      m.recordTestResult(false);
      m.recordTestResult(false); // → Tier2
      m.recordTestResult(true);
      m.recordTestResult(false);
      m.recordTestResult(false); // → Tier3

      const r = m.checkBudget(100_000);
      expect(r.halt).toBe(true);
      expect(r.escalated).toBe(false);
    });
  });

  // ── Multi-turn simulations ───────────────────────────────────────────────

  describe('multi-turn simulations', () => {
    it('session escalates via test failures and continues', () => {
      const m = new TokenBudgetManager(tieredConfig());
      const events: string[] = [];

      // Turn 1: 10K tokens, test passes
      m.recordTestResult(true);
      let r = m.checkBudget(10_000);
      if (r.warning) events.push('warning@10000');

      // Turn 2: 15K tokens, test fails (1st failure)
      m.recordTestResult(false);
      r = m.checkBudget(15_000);
      if (r.warning) events.push('warning@15000');

      // Turn 3: 20K tokens, test fails again → escalation via recordTestResult
      const escalatedBySignal = m.recordTestResult(false);
      if (escalatedBySignal) events.push(`escalated@signal→${m.tier}`);
      // Budget is now 50K (Tier2), so 20K/50K = 0.4 — no warning
      r = m.checkBudget(20_000);
      if (r.warning) events.push('warning@20000');

      // Turn 4: 35K tokens — 70% of 50K, no warning
      r = m.checkBudget(35_000);
      if (r.warning) events.push('warning@35000');

      // Turn 5: 45K tokens → 80% of Tier2 (50K), warning
      r = m.checkBudget(45_000);
      if (r.warning) events.push('warning@45000');

      // Turn 6: 50K → halt at Tier2
      r = m.checkBudget(50_000);
      if (r.halt) events.push('halt@50000');

      expect(events).toEqual([
        'escalated@signal→2',   // escalated immediately via recordTestResult
        'warning@45000',        // 80% of Tier2 at 45K
        'halt@50000',           // halt at Tier2
      ]);
    });

    it('session escalates via scope expansion and continues', () => {
      const m = new TokenBudgetManager(tieredConfig());

      // Modify 5 files → Tier1 → Tier2
      for (let i = 0; i < 5; i++) m.recordFileModification(`file${i}.ts`);
      expect(m.tier).toBe(BudgetTier.TIER2_ESCALATION);
      expect(m.budget).toBe(50_000);

      // Modify 5 more files → Tier2 → Tier3
      for (let i = 5; i < 10; i++) m.recordFileModification(`file${i}.ts`);
      expect(m.tier).toBe(BudgetTier.TIER3_HARD_CAP);
      expect(m.budget).toBe(100_000);

      // Budget check at 100K → halt
      const r = m.checkBudget(100_000);
      expect(r.halt).toBe(true);
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('all tiers equal (100K each) behaves like flat budget', () => {
      const m = new TokenBudgetManager(tieredConfig(100_000, 100_000, 100_000));
      expect(m.isTiered).toBe(true);
      expect(m.budget).toBe(100_000);

      // Escalate — budget stays the same
      m.recordTestResult(false);
      m.recordTestResult(false);
      expect(m.budget).toBe(100_000);
    });

    it('handles zero tokens used', () => {
      const m = new TokenBudgetManager(tieredConfig());
      const r = m.checkBudget(0);
      expect(r.halt).toBe(false);
      expect(r.warning).toBe(false);
    });

    it('handles budget smaller than a single turn — halts without signals', () => {
      const m = new TokenBudgetManager(tieredConfig(1_000, 2_000, 5_000));
      const r = m.checkBudget(5_000);
      // No escalation signals present → halts at Tier1
      expect(r.halt).toBe(true);
      expect(m.tier).toBe(BudgetTier.TIER1_BASELINE);
    });

    it('handles budget smaller than a single turn — escalates with signals', () => {
      const m = new TokenBudgetManager(tieredConfig(1_000, 2_000, 5_000));
      // Add escalation signals
      m.recordTestResult(false);
      m.recordTestResult(false); // → Tier2
      expect(m.tier).toBe(BudgetTier.TIER2_ESCALATION);
      expect(m.budget).toBe(2_000);

      // Now check at 5K which exceeds Tier2 (2K) — no more signals → halts
      const r = m.checkBudget(5_000);
      expect(r.halt).toBe(true);
      expect(m.tier).toBe(BudgetTier.TIER2_ESCALATION);
    });

    it('budget check at exactly 80% fires warning', () => {
      const m = new TokenBudgetManager(tieredConfig(10_000, 20_000, 30_000));
      const r = m.checkBudget(8_000); // exactly 80% of 10K
      expect(r.warning).toBe(true);
    });

    it('budget check at 79.9% does not fire warning', () => {
      const m = new TokenBudgetManager(tieredConfig(100_000, 200_000, 300_000));
      const r = m.checkBudget(79_999);
      expect(r.warning).toBe(false);
    });
  });
});
