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
 */
export function makeGuardedTaskEmit(
  deps: TaskEndGuardDeps,
  sessionId: string,
): (m: PortMessageToPanel) => void {
  return (m) => {
    deps.post(m);
    if (m.type !== "chat-done" && m.type !== "agent-done-task") return;
    markSessionEnded(sessionId);
    void reclaimLateInstructions(deps, sessionId);
  };
}
