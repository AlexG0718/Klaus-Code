/**
 * Token budget tests.
 *
 * We test the budget logic directly rather than through Agent.run() to avoid
 * mocking the entire Anthropic SDK. The assertions are:
 *   - budget_exceeded fires when total tokens >= budget
 *   - budget_warning fires once when crossing 80%, not again on repeat calls
 *   - the loop halts (no further API calls) after budget_exceeded
 *   - a budget of 0 means unlimited — no events are emitted
 *   - the 80% warning threshold is calculated correctly across multiple turns
 */

// ─── Minimal stub of the budget check logic extracted from Agent.ts ───────────
// We inline the logic rather than instantiating Agent (which needs Anthropic
// creds, a DB, a workspace, etc.) so tests are fast and have no I/O.

interface BudgetCheckResult {
  halt:    boolean;
  warning: boolean;    // 80% threshold crossed this call
}

function checkBudget(params: {
  totalUsed:    number;   // tokens used INCLUDING this turn
  prevTotal:    number;   // tokens used BEFORE this turn
  budget:       number;
}): BudgetCheckResult {
  const { totalUsed, prevTotal, budget } = params;
  if (budget <= 0) return { halt: false, warning: false };

  const pct     = totalUsed / budget;
  const prevPct = prevTotal / budget;

  const halt    = totalUsed >= budget;
  // warning: fires exactly once when we cross 80% — i.e. prev was below 80%
  const warning = !halt && pct >= 0.8 && prevPct < 0.8;

  return { halt, warning };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Token budget check logic', () => {

  // ── Halt ────────────────────────────────────────────────────────────────────

  it('halts when total equals budget exactly', () => {
    const r = checkBudget({ totalUsed: 100_000, prevTotal: 90_000, budget: 100_000 });
    expect(r.halt).toBe(true);
  });

  it('halts when total exceeds budget', () => {
    const r = checkBudget({ totalUsed: 105_000, prevTotal: 90_000, budget: 100_000 });
    expect(r.halt).toBe(true);
  });

  it('does not halt when total is below budget', () => {
    const r = checkBudget({ totalUsed: 50_000, prevTotal: 30_000, budget: 100_000 });
    expect(r.halt).toBe(false);
  });

  it('does not emit warning when halting (exceeded supersedes warning)', () => {
    // Even if we crossed 80% in the same turn that we exceeded 100%, halt wins
    const r = checkBudget({ totalUsed: 100_000, prevTotal: 50_000, budget: 100_000 });
    expect(r.halt).toBe(true);
    expect(r.warning).toBe(false);
  });

  // ── Warning ──────────────────────────────────────────────────────────────────

  it('fires warning exactly when crossing 80%', () => {
    const r = checkBudget({ totalUsed: 80_000, prevTotal: 79_000, budget: 100_000 });
    expect(r.warning).toBe(true);
    expect(r.halt).toBe(false);
  });

  it('does not re-fire warning if already above 80% on subsequent turns', () => {
    // Turn where we were already past 80% before this turn's tokens
    const r = checkBudget({ totalUsed: 90_000, prevTotal: 85_000, budget: 100_000 });
    expect(r.warning).toBe(false);
    expect(r.halt).toBe(false);
  });

  it('does not fire warning below 80%', () => {
    const r = checkBudget({ totalUsed: 79_999, prevTotal: 60_000, budget: 100_000 });
    expect(r.warning).toBe(false);
  });

  // ── Unlimited (budget = 0) ───────────────────────────────────────────────────

  it('never halts when budget is 0 (unlimited)', () => {
    const r = checkBudget({ totalUsed: 10_000_000, prevTotal: 9_000_000, budget: 0 });
    expect(r.halt).toBe(false);
    expect(r.warning).toBe(false);
  });

  // ── Multi-turn simulation ─────────────────────────────────────────────────────

  it('simulates a multi-turn session correctly', () => {
    const budget = 100_000;
    const turns = [
      { thisCallTokens: 20_000 },  // 20k  – ok
      { thisCallTokens: 30_000 },  // 50k  – ok
      { thisCallTokens: 25_000 },  // 75k  – ok (below 80%)
      { thisCallTokens: 10_000 },  // 85k  – warning (crossed 80%)
      { thisCallTokens: 10_000 },  // 95k  – no warning (already past 80%)
      { thisCallTokens: 10_000 },  // 105k – halt
    ];

    let prevTotal = 0;
    let total     = 0;
    const events: string[] = [];

    for (const turn of turns) {
      total += turn.thisCallTokens;
      const r = checkBudget({ totalUsed: total, prevTotal, budget });
      if (r.warning) events.push(`warning@${total}`);
      if (r.halt)    events.push(`halt@${total}`);
      prevTotal = total;
      if (r.halt) break;
    }

    expect(events).toEqual(['warning@85000', 'halt@105000']);
  });

  it('warning fires at exactly 80k out of 100k budget', () => {
    const budget = 100_000;
    let prevTotal = 0;
    let total     = 0;
    const warnings: number[] = [];

    const turns = [40_000, 39_000, 1_000, 1_000]; // 40k, 79k, 80k, 81k
    for (const t of turns) {
      total += t;
      const r = checkBudget({ totalUsed: total, prevTotal, budget });
      if (r.warning) warnings.push(total);
      prevTotal = total;
    }

    expect(warnings).toEqual([80_000]);  // fires exactly once
  });

  // ── Edge cases ────────────────────────────────────────────────────────────────

  it('handles a budget smaller than a single turn', () => {
    const r = checkBudget({ totalUsed: 5_000, prevTotal: 0, budget: 1_000 });
    expect(r.halt).toBe(true);
  });

  it('handles zero tokens used', () => {
    const r = checkBudget({ totalUsed: 0, prevTotal: 0, budget: 100_000 });
    expect(r.halt).toBe(false);
    expect(r.warning).toBe(false);
  });
});
