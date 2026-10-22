import type {Clock,Plan,Checkpoint,Batch,Runtime,Options,RuntimeEvent,RuntimeEventCode} from './index.js';
export interface Authority {evaluate(resource:string,clock:string,offline:boolean):string;invalidated(resources:string,clock:string,offline:boolean):string;prepare_snapshot(input:string):string;prepare_changes(input:string):string;acknowledge(id:string,revision:string):void;fence():void;close():void;snapshot():string;phase():string}
/** Shared host orchestration. Authorization and transitions belong to Rust. */
export async function createDrivenRuntime(options:Omit<Options,'wasmBytes'> & {authority:Authority;clone<T>(value:T):T}):Promise<Runtime>{
  const authority=options.authority;
  const { clock: readClock, commit, onInvalidate, onEvent } = options;
  const decode = <T>(call: () => string): T => {
    try { return JSON.parse(call()) as T; }
    catch (error) { throw new Error(String(error)); }
  };
  let generation = 0, busy = false, dead = false;
  let lastClock: Clock | undefined;
  const visible = new Set<string>();
  let observing = false, dropped = 0, readCount = 0, deniedCount = 0, lastOffline = false;
  let lastDenial: RuntimeEvent['reason'];
  const emit = (code: RuntimeEventCode, level: RuntimeEvent['level'] = 'info', reason?: RuntimeEvent['reason'], count?: number, durationMs?: number) => {
    if (!onEvent) return;
    if (observing) { dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); return; }
    observing = true;
    try {
      const event: RuntimeEvent = Object.freeze({schemaVersion: 1 as const, code, level,
        phase: authority.phase() as Checkpoint['phase'],
        ...(reason ? {reason} : {}), ...(count === undefined ? {} : {count}),
        ...(durationMs === undefined || !Number.isFinite(durationMs) ? {} : {durationMs: Math.max(0, Math.round(durationMs * 1000) / 1000)}),
        ...(dropped ? {droppedEvents: dropped} : {}),
      });
      dropped = 0;
      const result = onEvent(event);
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).then(() => { observing = false; }, () => { observing = false; dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); });
      } else observing = false;
    } catch { observing = false; dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); }
  };

  const notify = (ids: string[]) => {
    for (const id of ids) visible.delete(id);
    if (ids.length) { if (onEvent) emit('resources_invalidated', 'info', undefined, ids.length); onInvalidate?.(ids); }
  };
  const fence = (phase: 'closed' | 'resync_required', reason?: RuntimeEvent['reason']) => {
    dead = true; generation++;
    try { if (phase === 'closed') authority.close(); else authority.fence(); }
    finally {
      try { notify([...visible]); }
      finally { if (onEvent) emit(phase === 'closed' ? 'runtime_closed' : 'runtime_fenced', phase === 'closed' ? 'info' : 'warn', reason, phase === 'closed' ? readCount : undefined); }
    }
  };
  const clock = (): Clock => {
    const sample = readClock();
    if (!sample.boot || !Number.isSafeInteger(sample.now_ms) || sample.now_ms < 0 ||
        (lastClock && (sample.boot !== lastClock.boot || sample.now_ms < lastClock.now_ms))) {
      fence('resync_required', 'clock_discontinuity'); throw new Error('clock_discontinuity');
    }
    lastClock = { ...sample };
    return { ...sample };
  };
  const decide = (resource: string, offline: boolean) =>
    decode<{allowed: boolean; reason: string}>(() => authority.evaluate(resource, JSON.stringify(clock()), offline));
  const prune = (offline: boolean) => {
    const ids = [...visible], sample = JSON.stringify(clock());
    for (let at = 0; at < Math.max(ids.length, 1); at += 1024) {
      notify(decode<string[]>(() => authority.invalidated(JSON.stringify(ids.slice(at, at + 1024)), sample, offline)));
    }
  };
  const apply = async (kind: 'snapshot' | 'changes', incoming: Checkpoint | Batch): Promise<void> => {
    if (dead) throw new Error('runtime_unavailable');
    if (busy) throw new Error('commit_in_progress');
    busy = true;
    const started = ++generation, began = onEvent ? performance.now() : 0;
    let stage: 'prepare' | 'persist' | 'ack' = 'prepare';
    try {
      clock();
      const prepared = decode<{transition_id: string; plan: Plan}>(() => kind === 'snapshot'
        ? authority.prepare_snapshot(JSON.stringify(incoming)) : authority.prepare_changes(JSON.stringify(incoming)));
      prune(false);
      if (dead || generation !== started) throw new Error('context_changed');
      stage = 'persist';
      const revision = await commit(options.clone(prepared.plan));
      if (dead || generation !== started) throw new Error('context_changed');
      stage = 'ack';
      authority.acknowledge(prepared.transition_id, revision);
      prune(false);
      lastDenial = undefined;
      if (onEvent) emit(kind === 'snapshot' ? 'snapshot_applied' : 'changes_applied', 'info', undefined, Object.keys(prepared.plan.next.resources).length, performance.now() - began);
    } catch (error) {
      const reason: RuntimeEvent['reason'] = dead || generation !== started ? 'context_changed' : stage === 'persist' ? 'persistence_failed' : 'transition_failed';
      if (!dead) fence('resync_required', reason);
      if (onEvent) emit('operation_failed', 'error', reason, undefined, performance.now() - began);
      throw error;
    } finally { busy = false; }
  };
  const deny = (verdict: {reason: string}, resource: string): never => {
    if (onEvent) {
      deniedCount = Math.min(Number.MAX_SAFE_INTEGER, deniedCount + 1);
      let reason: RuntimeEvent['reason'] = 'authorization_denied';
      for (const known of ['not_ready', 'resource_not_found', 'resource_invalid', 'scope_not_found', 'scope_invalid'] as const) {
        if (verdict.reason === known) { reason = known; break; }
      }
      if (reason !== lastDenial) { lastDenial = reason; emit('read_denied', 'info', reason, deniedCount); }
    }
    notify(visible.has(resource) ? [resource] : []);
    throw new Error(verdict.reason);
  };
  if (onEvent) emit('runtime_initialized');
  return {
    async get<T>(resource: string, read: () => Promise<T>, offline = false): Promise<T> {
      if (dead) throw new Error('runtime_unavailable');
      const started = generation;
      let verdict;
      try { verdict = decide(resource, offline); }
      catch (error) { if (!dead) fence('resync_required'); throw error; }
      if (!verdict.allowed) return deny(verdict, resource);
      const value = await read();
      if (dead || generation !== started) throw new Error('context_changed');
      try { verdict = decide(resource, offline); }
      catch (error) { if (!dead) fence('resync_required'); throw error; }
      if (!verdict.allowed) return deny(verdict, resource);
      visible.add(resource);
      if (onEvent) {
        readCount = Math.min(Number.MAX_SAFE_INTEGER, readCount + 1); lastDenial = undefined;
        if (offline !== lastOffline) { lastOffline = offline; emit(offline ? 'offline_read' : 'online_resumed'); }
      }
      return value;
    },
    applySnapshot(snapshot: Checkpoint): Promise<void> { return apply('snapshot', snapshot); },
    applyChanges(batch: Batch): Promise<void> { return apply('changes', batch); },
    tick(offline = false): void {
      if (dead) return;
      try { prune(offline); }
      catch (error) { if (!dead) fence('resync_required'); throw error; }
    },
    close(): void { fence('closed'); },
    snapshot(): Checkpoint { return decode<Checkpoint>(() => authority.snapshot()); },
  };
}
