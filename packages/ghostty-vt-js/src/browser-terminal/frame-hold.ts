export const SYNCHRONIZED_OUTPUT_MAX_HOLD_MS = 150;

export type FrameHoldAction = 'paint' | 'skip';

export interface FrameHoldDecision {
  action: FrameHoldAction;
  holdStartMs: number | undefined;
}

/**
 * Decide whether the frame scheduler should paint while synchronized output is
 * active. The original hold timestamp is retained after the safety valve
 * expires so a mode that is never cleared paints every subsequent frame.
 */
export function decideSynchronizedOutputFrameHold(
  active: boolean,
  holdStartMs: number | undefined,
  nowMs: number,
): FrameHoldDecision {
  if (!active) {
    return { action: 'paint', holdStartMs: undefined };
  }

  const effectiveHoldStartMs = holdStartMs ?? nowMs;
  const action = nowMs - effectiveHoldStartMs >= SYNCHRONIZED_OUTPUT_MAX_HOLD_MS
    ? 'paint'
    : 'skip';
  return { action, holdStartMs: effectiveHoldStartMs };
}
