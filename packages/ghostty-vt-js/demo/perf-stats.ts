export interface PerformanceSummary {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  droppedFrames: number;
  longTasks: number;
  longTaskMs: number;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

/** Pure stats authority shared by all demo instruments. */
export function summarizePerformanceStats(
  samples: readonly number[],
  longTaskDurations: readonly number[] = [],
  frameBudgetMs: number = 1_000 / 60,
): PerformanceSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? 0,
    droppedFrames: sorted.reduce(
      (total, duration) => total + Math.max(0, Math.round(duration / frameBudgetMs) - 1),
      0,
    ),
    longTasks: longTaskDurations.length,
    longTaskMs: longTaskDurations.reduce((total, duration) => total + duration, 0),
  };
}
