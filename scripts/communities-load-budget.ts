export interface LoadMeasurementSummary {
  readonly operations: number;
  readonly durationMs: number;
  readonly throughputRps: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export interface LoadBudgetSpec {
  readonly name: string;
  readonly result: LoadMeasurementSummary;
  readonly p95TargetMs: number;
  readonly p99TargetMs: number;
  readonly minimumRps?: number;
}

export interface LoadBudgetBreach {
  readonly name: string;
  readonly result: LoadMeasurementSummary;
  readonly p95TargetMs: number;
  readonly p99TargetMs: number;
  readonly minimumRps: number | null;
  readonly violations: readonly ('p95' | 'p99' | 'throughput')[];
}

export function collectLoadBudgetBreaches(
  budgets: readonly LoadBudgetSpec[],
): readonly LoadBudgetBreach[] {
  return budgets.flatMap((budget) => {
    const violations: ('p95' | 'p99' | 'throughput')[] = [];
    if (budget.result.p95Ms > budget.p95TargetMs) violations.push('p95');
    if (budget.result.p99Ms > budget.p99TargetMs) violations.push('p99');
    if (budget.minimumRps !== undefined && budget.result.throughputRps < budget.minimumRps) {
      violations.push('throughput');
    }
    return violations.length === 0
      ? []
      : [
          {
            name: budget.name,
            result: budget.result,
            p95TargetMs: budget.p95TargetMs,
            p99TargetMs: budget.p99TargetMs,
            minimumRps: budget.minimumRps ?? null,
            violations,
          },
        ];
  });
}
