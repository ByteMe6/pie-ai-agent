import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  beginTask,
  currentGeneration,
  endTask,
  isSessionEnded,
  makeGuardedTaskEmit,
  markSessionEnded,
  reclaimLateInstructions,
  reopenSession,
} from "./task-end-guard";
import type { PortMessageToPanel } from "@/types/messages";
import type { PendingInstruction } from "@/lib/sessions/types";

const SESSION_ID = "s1";

const instr = (id: string): PendingInstruction => ({
  chatMessageId: id,
  content: `msg ${id}`,
  createdAt: 1,
});

function makeDeps(queue: PendingInstruction[] = []) {
  const posted: PortMessageToPanel[] = [];
  return {
    posted,
    deps: {
      post: (m: PortMessageToPanel) => {
        posted.push(m);
      },
      drainPending: async () => {
        const drained = [...queue];
        queue.length = 0;
        return drained;
      },
    },
  };
}

beforeEach(() => {
  reopenSession(SESSION_ID);
});

describe("session end state", () => {
  it("starts open and closes on mark", () => {
    expect(isSessionEnded(SESSION_ID)).toBe(false);
    markSessionEnded(SESSION_ID);
    expect(isSessionEnded(SESSION_ID)).toBe(true);
  });

  it("reopens for the next task", () => {
    markSessionEnded(SESSION_ID);
    reopenSession(SESSION_ID);
    expect(isSessionEnded(SESSION_ID)).toBe(false);
  });
});

describe("makeGuardedTaskEmit", () => {
  it("forwards every message to the panel", () => {
    const { posted, deps } = makeDeps();
    const emit = makeGuardedTaskEmit(deps, SESSION_ID);
    emit({ type: "chat-chunk", text: "hi", sessionId: SESSION_ID });
    expect(posted.map((m) => m.type)).toEqual(["chat-chunk"]);
    // A chunk is not a terminal message — the queue stays open.
    expect(isSessionEnded(SESSION_ID)).toBe(false);
  });

  it("closes the queue on chat-done", () => {
    const { posted, deps } = makeDeps();
    const emit = makeGuardedTaskEmit(deps, SESSION_ID);
    emit({ type: "chat-done", sessionId: SESSION_ID });
    expect(isSessionEnded(SESSION_ID)).toBe(true);
    expect(posted.map((m) => m.type)).toEqual(["chat-done"]);
  });

  it("closes the queue on agent-done-task", () => {
    const { deps } = makeDeps();
    const emit = makeGuardedTaskEmit(deps, SESSION_ID);
    emit({
      type: "agent-done-task",
      success: true,
      summary: "done",
      stepCount: 3,
      sessionId: SESSION_ID,
    });
    expect(isSessionEnded(SESSION_ID)).toBe(true);
  });

  it("reclaims an instruction that raced past the loop's last queue check", async () => {
    const queue = [instr("late-1")];
    const { posted, deps } = makeDeps(queue);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID);

    // The instruction is queued AFTER the loop's final check but BEFORE the
    // final emit.
    emit({ type: "chat-done", sessionId: SESSION_ID });
    await vi.waitFor(() => expect(posted).toHaveLength(2));

    expect(posted[1]).toMatchObject({
      type: "chat-instruction-rejected",
      sessionId: SESSION_ID,
      chatMessageId: "late-1",
      reason: "not-streaming",
    });
    // The queue is empty — the instruction was taken out, not left to rot.
    expect(queue).toHaveLength(0);
  });

  it("posts ONE rejection when several instructions raced in", async () => {
    const queue = [instr("late-1"), instr("late-2"), instr("late-3")];
    const { posted, deps } = makeDeps(queue);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID);

    emit({ type: "chat-done", sessionId: SESSION_ID });
    await vi.waitFor(() => expect(posted).toHaveLength(2));

    // The panel's fallback re-sends the whole conversation, so one rejection
    // covers all three — more would start several tasks.
    expect(posted.filter((m) => m.type === "chat-instruction-rejected")).toHaveLength(1);
    expect(queue).toHaveLength(0);
  });

  it("posts no rejection when the queue was already drained", async () => {
    const { posted, deps } = makeDeps([]);
    const emit = makeGuardedTaskEmit(deps, SESSION_ID);
    emit({ type: "chat-done", sessionId: SESSION_ID });
    await new Promise((r) => setTimeout(r, 5));
    expect(posted.map((m) => m.type)).toEqual(["chat-done"]);
  });
});

describe("reclaimLateInstructions", () => {
  it("does nothing when the queue is empty", async () => {
    const { posted, deps } = makeDeps([]);
    await reclaimLateInstructions(deps, SESSION_ID);
    expect(posted).toHaveLength(0);
  });

  it("hands the instruction back to the panel", async () => {
    const { posted, deps } = makeDeps([instr("x")]);
    await reclaimLateInstructions(deps, SESSION_ID);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "chat-instruction-rejected",
      chatMessageId: "x",
    });
  });
});

describe("task generations", () => {
  it("beginTask bumps the generation and reopens the queue", () => {
    beginTask(SESSION_ID);
    markSessionEnded(SESSION_ID);
    expect(isSessionEnded(SESSION_ID)).toBe(true);
    const gen = beginTask(SESSION_ID);
    expect(isSessionEnded(SESSION_ID)).toBe(false);
    expect(currentGeneration(SESSION_ID)).toBe(gen);
  });

  it("a superseded task's terminal emit does not close the new task's queue", async () => {
    const queue = [instr("for-the-new-task")];
    const { posted, deps } = makeDeps(queue);

    // Task A starts…
    beginTask(SESSION_ID);
    const emitA = makeGuardedTaskEmit(deps, SESSION_ID);

    // …the panel starts task B before A winds down.
    beginTask(SESSION_ID);
    const emitB = makeGuardedTaskEmit(deps, SESSION_ID);

    // A's late terminal emit (the abort path emits from the loop's finally,
    // after the new task already started) must not touch B's queue.
    emitA({ type: "agent-done-task", success: false, summary: "aborted", stepCount: 2, sessionId: SESSION_ID });
    await new Promise((r) => setTimeout(r, 5));

    expect(isSessionEnded(SESSION_ID)).toBe(false);
    expect(posted.filter((m) => m.type === "chat-instruction-rejected")).toHaveLength(0);
    expect(queue).toHaveLength(1); // B's instruction is untouched

    // B's own terminal emit does close the queue.
    emitB({ type: "chat-done", sessionId: SESSION_ID });
    await vi.waitFor(() => expect(isSessionEnded(SESSION_ID)).toBe(true));
  });

  it("endTask is a no-op for a stale generation", async () => {
    const { posted, deps } = makeDeps([instr("x")]);
    const stale = currentGeneration(SESSION_ID);
    beginTask(SESSION_ID); // a newer task takes over
    endTask(deps, SESSION_ID, stale);
    await new Promise((r) => setTimeout(r, 5));
    expect(isSessionEnded(SESSION_ID)).toBe(false);
    expect(posted).toHaveLength(0);
  });
});
