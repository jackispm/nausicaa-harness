import type { A2AInbox, InboxClaim, InboxRecord } from "../a2a/index.js";
import type { AnyEvent, EventPayloadMap, EventType } from "../domain/events.js";
import type { Clock } from "../domain/ports.js";
import type { TeamDefinition, TeamMemberDefinition, TeamMemberOutcome } from "../domain/team.js";
import type { A2AMessage, TaskFailed, TaskResult } from "../domain/types.js";
import type { Ledger } from "../ledger/index.js";
import { projectTeamBoards, type TeamBoard, type TeamBoardMember } from "./team-board.js";

interface TeamLifecycleOptions {
  runId: string;
  leadLaneId: string;
  ledger: Ledger;
  inbox: A2AInbox;
  clock: Clock;
  readEvents: () => Promise<readonly AnyEvent[]>;
  stopMember: (laneId: string) => Promise<void>;
  onWake?: () => void;
}

/** Durable Team transitions; scheduling and model execution stay in TeamRuntime. */
export class TeamLifecycle {
  private tail: Promise<void> = Promise.resolve();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private lastFailure: unknown;

  constructor(private readonly options: TeamLifecycleOptions) {}

  boards(): Promise<TeamBoard[]> {
    return this.options.readEvents().then((events) => projectTeamBoards(events, {
      runId: this.options.runId, inbox: this.options.inbox.snapshot(),
    }).filter((board) => board.coordinator === this.options.leadLaneId));
  }

  async create(definition: TeamDefinition): Promise<void> {
    await this.exclusive(async () => {
      const existing = (await this.boards()).find((board) => board.teamId === definition.teamId)?.definition;
      if (existing !== undefined) {
        if (existing.fingerprint !== definition.fingerprint) throw new Error(`Team ${definition.teamId} already exists with different member requests`);
      } else {
        await this.append("team.created", definition, definition.teamId, "created");
      }
      this.arm(definition.teamId, definition.deadline);
    });
  }

  async restore(): Promise<void> {
    await this.reconcile();
    for (const board of await this.boards()) {
      if (board.reducer !== undefined && board.reductionState === "running") this.arm(`${board.teamId}:reducer`, board.reducer.task.budget.deadline!);
    }
  }

  settle(teamId: string, member: TeamMemberDefinition, request: A2AMessage, claim: InboxClaim, payload: TaskResult | TaskFailed, reducer = false): Promise<void> {
    return this.exclusive(async () => {
      if (this.stopped) throw new Error("Team runtime stopped before settlement");
      const board = await this.requireBoard(teamId);
      if (board.cancellationRequested) throw new Error("Team cancelled before settlement");
      const current = this.options.inbox.snapshot().records.find((record) => record.message.messageId === request.messageId);
      if (current?.claim?.claimId !== claim.claimId || current.claim.attempt !== claim.attempt) throw new Error("Team task claim was superseded");
      if (payload.taskId !== member.task.taskId || request.to !== member.laneId || request.from !== this.options.leadLaneId) throw new Error("Team task settlement does not match admission");
      const taskDeadline = Date.parse(member.task.budget.deadline
        ?? new Date(Date.parse(request.createdAt) + member.task.budget.maxWallClockMs).toISOString());
      const deadline = Math.min(taskDeadline, reducer ? Infinity : Date.parse(board.definition?.deadline ?? new Date(taskDeadline).toISOString()));
      if (this.options.clock.now().getTime() >= deadline) {
        if (reducer) await this.append("team.reduced", { teamId, outcome: "abandoned" }, teamId, "reduced");
        else await this.append("team.member.settled", { teamId, memberId: member.memberId, taskId: member.task.taskId, outcome: "abandoned", reason: "Task completed after its deadline" }, teamId, `member:${member.memberId}:settled`);
        throw new Error("Team task completed after its deadline");
      }
      const outcome = payload.type === "task.failed" ? "failed" : payload.status === "partial" ? "partial" : "succeeded";
      const result = payload.type === "task.result" ? { result: payload } : { failure: payload };
      if (reducer) {
        if (board.reductionState !== "running") throw new Error("Team reduction is already settled");
        await this.append("team.reduced", { teamId, outcome, ...result }, teamId, "reduced");
      } else {
        const previous = board.members.find((item) => item.memberId === member.memberId);
        if (previous?.terminal) throw new Error("Team task is already settled");
        await this.append("team.member.settled", {
          teamId, memberId: member.memberId, taskId: member.task.taskId, requestMessageId: request.messageId,
          claimId: claim.claimId, attempt: claim.attempt, outcome, ...result,
        }, teamId, `member:${member.memberId}:settled`);
      }
    });
  }

  cancel(teamId: string, reason: string): Promise<void> {
    return this.exclusive(async () => {
      const board = await this.requireBoard(teamId);
      if (!board.cancellationRequested) await this.append("team.cancel.requested", {
        teamId, reason, requestedBy: this.options.leadLaneId,
      }, teamId, "cancel:requested");
      await this.reconcileInternal();
    });
  }

  requestReduction(teamId: string, reducer: TeamMemberDefinition): Promise<void> {
    return this.exclusive(async () => {
      const board = await this.requireBoard(teamId);
      if (!board.joinSatisfied || board.cancellationRequested || board.presentationState !== "pending") throw new Error("Reduction requires a joined, unpresented Team");
      if (board.reducer !== undefined) throw new Error("Team already has a reducer");
      await this.append("team.reduction.requested", { teamId, reducer }, teamId, "reduction:requested");
      this.arm(`${teamId}:reducer`, reducer.task.budget.deadline!);
    });
  }

  present(teamId: string, disposition: "accepted" | "rejected"): Promise<void> {
    return this.exclusive(async () => {
      const board = await this.requireBoard(teamId);
      if (!board.joinSatisfied || board.cancellationRequested || board.reductionState === "running") throw new Error("Team must join and finish any reduction before presentation");
      if (board.presentationState !== "pending" && board.presentationState !== disposition) throw new Error("Team already has a different presentation decision");
      await this.append("team.presented", { teamId, disposition }, teamId, "presented");
    });
  }

  reconcile(): Promise<void> {
    return this.exclusive(() => this.reconcileInternal());
  }

  private async reconcileInternal(): Promise<void> {
    if (this.stopped) return;
    const events = await this.options.readEvents();
    const records = this.options.inbox.snapshot().records;
    for (let board of await this.boards()) {
      const definition = board.definition;
      const cancellation = events.find((event) => event.runId === this.options.runId
        && event.laneId === this.options.leadLaneId && event.type === "team.cancel.requested"
        && event.payload.teamId === board.teamId && event.payload.requestedBy === this.options.leadLaneId);
      if (board.cancellationRequested && cancellation?.type === "team.cancel.requested") {
        await this.terminateMembers(board, "cancelled", cancellation.payload.reason);
        if (board.reducer !== undefined && board.reductionState === "running") {
          await this.options.stopMember(board.reducer.laneId);
          await this.append("team.reduced", { teamId: board.teamId, outcome: "cancelled" }, board.teamId, "reduced");
        }
        await this.append("team.cancelled", { teamId: board.teamId, reason: cancellation.payload.reason }, board.teamId, "cancelled");
        await this.notify(board.teamId, "cancelled", `Team ${board.teamId} cancelled. ${cancellation.payload.reason}`);
        this.clearTimer(board.teamId);
        this.clearTimer(`${board.teamId}:reducer`);
        continue;
      }
      const now = this.options.clock.now().getTime();
      const expired = definition !== undefined && now >= Date.parse(definition.deadline);
      if (!board.joinSatisfied) {
        for (const member of board.members) {
          if (member.terminal) continue;
          const failedDependency = member.dependsOn.find((id) => board.members.some((item) => item.memberId === id && item.terminal && item.outcome !== "succeeded"));
          const deadline = memberDeadline(board, member, records);
          if (expired || deadline === undefined || now >= deadline || failedDependency !== undefined) {
            await this.options.stopMember(member.laneId);
            await this.append("team.member.settled", {
              teamId: board.teamId, memberId: member.memberId, taskId: member.taskId,
              outcome: failedDependency === undefined ? "abandoned" : "failed",
              reason: failedDependency !== undefined ? `Dependency ${failedDependency} did not succeed`
                : deadline === undefined ? "Task deadline cannot be reconstructed from admission" : "Task deadline expired",
            }, board.teamId, `member:${member.memberId}:settled`);
          }
        }
        board = await this.requireBoard(board.teamId);
        if (board.joinReady) {
          await this.terminateMembers(board, "cancelled", "Required Team tasks settled; optional work closed");
          board = await this.requireBoard(board.teamId);
          await this.append("team.joined", {
            teamId: board.teamId,
            reason: expired && definition?.joinPolicy === "deadline-best-effort" ? "deadline-best-effort" : "all-terminal",
            memberOutcomes: board.members.filter((member) => member.outcome !== undefined).map((member) => ({ memberId: member.memberId, taskId: member.taskId, outcome: member.outcome! })),
          }, board.teamId, "joined");
          board = await this.requireBoard(board.teamId);
        }
      }
      if (!board.joinSatisfied) {
        const deadlines = board.members.filter((member) => !member.terminal)
          .map((member) => memberDeadline(board, member, records))
          .filter((deadline): deadline is number => deadline !== undefined);
        if (deadlines.length > 0) this.arm(board.teamId, new Date(Math.min(...deadlines)).toISOString());
      }
      if (board.joinSatisfied) {
        this.clearTimer(board.teamId);
        await this.notify(board.teamId, "joined", [
          `Team ${board.teamId} joined (${board.joinState}).`,
          ...board.members.map((member) => `${member.memberId}: ${member.outcome ?? "unknown"}. ${member.result?.summary.slice(0, 384) ?? member.failure?.reason ?? ""}`),
          "Main is the Team Lead. Inspect the member results and synthesize the answer, retaining partial and failed outcomes. team_reduce explicitly starts an optional synthesis lane. team_present records your acceptance or rejection.",
        ].join("\n").slice(0, 8_192));
      }
      if (board.reductionState === "running" && board.reducer !== undefined && now >= Date.parse(board.reducer.task.budget.deadline!)) {
        await this.options.stopMember(board.reducer.laneId);
        await this.append("team.reduced", { teamId: board.teamId, outcome: "abandoned" }, board.teamId, "reduced");
        board = await this.requireBoard(board.teamId);
      }
      if (board.reduction !== undefined) {
        this.clearTimer(`${board.teamId}:reducer`);
        await this.notify(board.teamId, "reduced", `Team ${board.teamId} reduction ${board.reduction.outcome}. ${board.reduction.result?.summary.slice(0, 4_096) ?? board.reduction.failure?.reason ?? ""}`);
      }
    }
  }

  private async terminateMembers(board: TeamBoard, outcome: TeamMemberOutcome, reason: string): Promise<void> {
    for (const member of board.members) {
      if (member.terminal) continue;
      await this.options.stopMember(member.laneId);
      await this.append("team.member.settled", { teamId: board.teamId, memberId: member.memberId, taskId: member.taskId, outcome, reason }, board.teamId, `member:${member.memberId}:settled`);
    }
  }

  private async notify(teamId: string, kind: string, text: string): Promise<void> {
    const messageId = `${this.options.runId}:team:${teamId}:${kind}:notice`;
    const existing = this.options.inbox.snapshot().records.find((record) => record.message.messageId === messageId);
    if (existing !== undefined) return;
    const sent = await this.options.inbox.send({
      messageId, runId: this.options.runId, from: this.options.leadLaneId, to: this.options.leadLaneId,
      conversationId: this.options.runId, threadId: `${this.options.runId}:team:${teamId}`,
      correlationId: `${this.options.runId}:team:${teamId}`, idempotencyKey: messageId,
      createdAt: this.options.clock.now().toISOString(), visibility: "run", priority: 5, delivery: "next-step",
      payload: { type: "message.inform", text },
    });
    if (sent.status === "queued") this.options.onWake?.();
  }

  private async requireBoard(teamId: string): Promise<TeamBoard> {
    const board = (await this.boards()).find((item) => item.teamId === teamId);
    if (board === undefined) throw new Error(`Unknown Team ${teamId}`);
    return board;
  }

  private append<K extends EventType>(type: K, payload: EventPayloadMap[K], teamId: string, suffix: string): Promise<unknown> {
    return this.options.ledger.append({
      runId: this.options.runId, laneId: this.options.leadLaneId, type, payload,
      correlationId: `${this.options.runId}:team:${teamId}`,
      idempotencyKey: `${this.options.runId}:team:${teamId}:${suffix}`, visibility: "run",
      occurredAt: this.options.clock.now().toISOString(),
    });
  }

  private arm(key: string, deadline: string): void {
    if (this.stopped) return;
    this.clearTimer(key);
    const delay = Math.max(1, Date.parse(deadline) - this.options.clock.now().getTime());
    const timer = setTimeout(() => {
      void this.reconcile().catch((error: unknown) => { this.lastFailure = error; });
    }, Math.min(delay, 2_147_483_647));
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.tail;
  }

  checkFailure(): void {
    if (this.lastFailure === undefined) return;
    const failure = this.lastFailure;
    this.lastFailure = undefined;
    throw failure;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function memberDeadline(board: TeamBoard, member: TeamBoardMember, records: readonly InboxRecord[]): number | undefined {
  const request = records.find((record) => record.message.runId === board.runId
    && record.message.messageId === member.requestMessageId)?.message;
  const deadline = member.budget.deadline === undefined
    ? request === undefined ? undefined : Date.parse(request.createdAt) + member.budget.maxWallClockMs
    : Date.parse(member.budget.deadline);
  if (deadline === undefined || !Number.isFinite(deadline)) return undefined;
  return Math.min(deadline, board.definition === undefined ? Infinity : Date.parse(board.definition.deadline));
}
