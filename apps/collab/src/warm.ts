/**
 * Keeping the checkpoint worker warm while people edit.
 *
 * Present and Save version wait for a `content-checkpoint` run. A run that
 * lands on a cold Trigger.dev machine pays the machine's start and the first
 * import of the renderers (BlockNote's server editor, jsdom) before it does
 * any work (on staging ~9 s to start and ~23 s to run, against ~3 s warm), and
 * Trigger.dev
 * keeps a machine for the next run only for a minute or so after a run ends.
 *
 * So while a classroom has a live doc open by a PERSON (a browser socket;
 * agents' direct connections don't count), collab sends a no-op warm-up run
 * of the same task (`{ classroomId, warm: true }`, see the task) at once and
 * then once a minute, and stops when nobody of that classroom is connected.
 *
 * Per classroom, one timer chain. "Active" is read from the live rooms every
 * time (`isActive`), never counted, so it cannot drift. The last send time
 * outlives the chain, so closing and reopening a doc inside the minute does
 * not send again: at most one warm-up per classroom per interval.
 */

export interface CheckpointWarmerOptions {
  /** Send one warm-up for the classroom (fire and forget; errors are the sender's). */
  send(classroomId: string): Promise<unknown>;
  /** Whether a person has a live doc of the classroom open right now. */
  isActive(classroomId: string): boolean;
  /** Default 60 s. */
  intervalMs?: number;
  now?: () => number;
}

export const CHECKPOINT_WARM_INTERVAL_MS = 60_000;

export class CheckpointWarmer {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastSent = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private stopped = false;
  private readonly options: CheckpointWarmerOptions;

  constructor(options: CheckpointWarmerOptions) {
    this.options = options;
    this.intervalMs = options.intervalMs ?? CHECKPOINT_WARM_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /** A person connected to a doc of the classroom: warm now (if due) and keep warming. */
  connected(classroomId: string): void {
    if (this.stopped || this.timers.has(classroomId)) return;
    if (!this.options.isActive(classroomId)) return;
    const last = this.lastSent.get(classroomId);
    const now = this.now();
    if (last === undefined || now - last >= this.intervalMs) {
      this.fire(classroomId);
    } else {
      this.schedule(classroomId, last + this.intervalMs - now);
    }
  }

  /** A connection of the classroom closed: stop once nobody is left. */
  disconnected(classroomId: string): void {
    if (this.options.isActive(classroomId)) return;
    this.cancel(classroomId);
  }

  /** Classrooms with a warm-up chain running (tests, diagnostics). */
  activeClassrooms(): string[] {
    return [...this.timers.keys()];
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.lastSent.clear();
  }

  private fire(classroomId: string): void {
    this.timers.delete(classroomId);
    if (this.stopped) return;
    if (!this.options.isActive(classroomId)) {
      this.prune();
      return;
    }
    this.lastSent.set(classroomId, this.now());
    void this.options.send(classroomId).catch(err => {
      console.error(`[collab] warm-up for classroom ${classroomId} failed:`, err);
    });
    this.schedule(classroomId, this.intervalMs);
  }

  private schedule(classroomId: string, delayMs: number): void {
    const timer = setTimeout(() => this.fire(classroomId), Math.max(0, delayMs));
    timer.unref();
    this.timers.set(classroomId, timer);
  }

  private cancel(classroomId: string): void {
    const timer = this.timers.get(classroomId);
    if (timer) clearTimeout(timer);
    this.timers.delete(classroomId);
    this.prune();
  }

  /** Forget send times old enough not to matter (the map stays small). */
  private prune(): void {
    const now = this.now();
    for (const [classroomId, at] of this.lastSent) {
      if (!this.timers.has(classroomId) && now - at >= this.intervalMs) {
        this.lastSent.delete(classroomId);
      }
    }
  }
}
