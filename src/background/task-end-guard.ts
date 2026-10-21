// src/background/task-end-guard.ts
//
// Issue #34 follow-up — the "task just ended" guard for the mid-task
// instruction queue.
//
// The queue is drained by the agent loop at the TOP of every step. Once the
// loop has produced its final answer (`chat-done` for a plain reply,
// `agent-done-task` for a done/fail termination) there is no step left, so
// nothing will drain the queue again.
//
// The window this module closes: the loop's final queue check happens BEFORE
// it emits its final answer, and the task's dispatch only tears down
// (in-flight bookkeeping) a few milliseconds later. An instruction that lands
// in that window would be accepted into the queue and then sit there forever:
// the user sees it as sent, the agent never answers it.
//
// The SW is the arbiter for that window:
//   - a task's final emit marks its session as ended;
//   - a `chat-instruction-add` for an ended session is rejected outright
//     (the panel falls back to a normal chat-start);
//   - an instruction that raced past the loop's final check is pulled back
//     out of the queue and handed to the panel the same way.

import type { PortMessageToPanel } from "@/types/messages";
import type { PendingInstruction } from "@/lib/sessions/types";

/**
 * Sessions whose CURRENT task has already emitted its final answer.
 *
 * Module-level (not per-port) for the same reason as `runningSessionIds`: the
 * flag belongs to the session, not to the panel that happens to be attached.
 */
const endedSessionIds = new Set<string>();

/**
 * Per-session task generation.
 *
 * A task that is superseded (the panel starts a new one while the old is
 * still winding down) can still emit its terminal message afterwards — the
 * abort path emits `agent-done-task` from the loop's `finally`, which lands
 * AFTER the new task started. Without a generation guard that late emit
 * would mark the NEW task's session as ended (closing its instruction queue)
 * and reclaim instructions belonging to it.
 *
 * Every task takes a generation number; a terminal emit only counts if its
 * generation is still the session's current one.
 */
const taskGenerations = new Map<string, number>();

/**
 * Register a new task for the session and reopen its instruction queue.
 * Returns the task's generation.
 */
export function beginTask(sessionId: string): number {
  const generation = (taskGenerations.get(sessionId) ?? 0) + 1;
  taskGenerations.set(sessionId, generation);
  endedSessionIds.delete(sessionId);
  return generation;
}

/** The generation of the session's current task (0 = none yet). */
export function currentGeneration(sessionId: string): number {
  return taskGenerations.get(sessionId) ?? 0;
}

/** Mark a session's task as finished — the instruction queue is now closed. */
export function markSessionEnded(sessionId: string): void {
  endedSessionIds.add(sessionId);
}

/** Has this session's current task already produced its final answer? */
export function isSessionEnded(sessionId: string): boolean {
  return endedSessionIds.has(sessionId);
}

/**
 * Reopen the queue for a session — a new (or resumed) task starts, so
 * instructions queued during it can be delivered again.
 */
export function reopenSession(sessionId: string): void {
  endedSessionIds.delete(sessionId);
}

/**
 * Close the queue for a task and hand back anything still in it.
 *
 * No-op when the task has been superseded (a newer task took over the
 * session): that newer task owns the queue now, and its instructions must
 * not be reclaimed by the old one.
 */
export function endTask(
  deps: TaskEndGuardDeps,
  sessionId: string,
  generation: number,
): void {
  if (currentGeneration(sessionId) !== generation) return;
  markSessionEnded(sessionId);
  void reclaimLateInstructions(deps, sessionId);
}

export interface TaskEndGuardDeps {
  /** Deliver a message to the panel. */
  post: (m: PortMessageToPanel) => void;
  /** Take everything out of the session's instruction queue. */
  drainPending: (sessionId: string) => Promise<PendingInstruction[]>;
}

/**
 * Pull instructions that arrived after the loop's last queue check back out
 * of the queue and hand them to the panel, which re-sends them as a normal
 * chat-start (the same fallback as `chat-instruction-rejected`).
 *
 * Only ONE rejection is posted even when several instructions raced in: the
 * panel's fallback re-sends the whole conversation (which contains every one
 * of them), so a single chat-start covers them all. The others are drained
 * from the queue so the next chat-start's carry-over merge does not repeat
 * them.
 */
export async function reclaimLateInstructions(
  deps: TaskEndGuardDeps,
  sessionId: string,
): Promise<void> {
  try {
    const late = await deps.drainPending(sessionId);
    if (late.length === 0) return;
    const first = late[0]!;
    deps.post({
      type: "chat-instruction-rejected",
      sessionId,
      chatMessageId: first.chatMessageId,
      reason: "not-streaming",
    });
  } catch (e) {
    console.warn(`[sw] late-instruction reclaim failed for session=${sessionId}:`, e);
  }
}

/**
 * The task's emit wrapper. A task's final answer closes the queue; anything
 * still in it at that moment is handed back to the panel.
 *
 * The task's generation is captured when the wrapper is created (i.e. when the
 * task starts), so a superseded task's late terminal emit cannot close the
 * queue of the task that replaced it.
 */
export function makeGuardedTaskEmit(
  deps: TaskEndGuardDeps,
  sessionId: string,
): (m: PortMessageToPanel) => void {
  const generation = currentGeneration(sessionId);
  return (m) => {
    deps.post(m);
    if (m.type !== "chat-done" && m.type !== "agent-done-task") return;
    endTask(deps, sessionId, generation);
  };
}
