/** Versioned host ports. Group metadata fences Resource permits; it never grants content. */
export interface ResourceGroup { binding: string; resourceGroupId: string }
export interface GroupPosition { epoch: string; sequence: string; cursor: string }
export interface GroupAnchor { resourceGroupId: string; epoch: string; sequence: string }
export interface GroupCheckpoint extends ResourceGroup, GroupPosition {
  schemaVersion: 2; kind: 'resource_group'; generation: string; revision: string;
  resources: Record<string, {grantGeneration: string|null; intent: 'revoke'|'revalidate'|null}>;
}
export interface GroupRow {
  term: string; owner: {id: string; context: string; until: number}|null;
  state: GroupCheckpoint|null;
}
export interface GroupCoordinationStorage {
  read(key: string): Promise<GroupRow|null>;
  /** One readonly transaction for the batch's common shared-store boundary. */
  readMany(keys: readonly string[]): Promise<(GroupRow|null)[]>;
  /** Runs a synchronous callback in a serializable durable transaction. No shared mutable references. */
  transaction<T>(key: string, work: (row: GroupRow|null) => {row: GroupRow; result: T}): Promise<T>;
}
export interface GroupStamp extends ResourceGroup {
  generation: string; term: string; epoch: string; sequence: string;
}
export interface GroupNotice extends ResourceGroup {
  schemaVersion: 1; namespace: string; term: string; revision: string;
}
type Reply = {status: number; json(): Promise<unknown>};
export interface ResourceGroupOptions {
  namespace: string; storage: GroupCoordinationStorage;
  session(): Promise<{binding: string; context: string; expiresAtMs: number}>;
  wall(): number; randomUUID(): string;
  transport: {
    subscribe(group: ResourceGroup, requestId: string): Promise<Reply>;
    fetch(group: ResourceGroup, query: {requestId: string; cursor: string}): Promise<Reply>;
  };
  /** Must compare expected term/generation inside the host's deletion transaction. */
  purge(input: ResourceGroup & {resourceId: string; action: 'revoke'|'revalidate'; expected: GroupStamp;
    assertCurrent(): Promise<void>}): Promise<{status: 'purged'|'blocked'}>;
  notify?(notice: GroupNotice): void|Promise<void>;
  listen?(receive: (notice: unknown) => void): () => void;
  pollIntervalMs?: number; ownerLeaseMs?: number;
  clone?<T>(value: T): T;
}
export interface ResourceGroupCoordinator {
  register(input: ResourceGroup & {resourceId: string}, invalidate?: (action: 'revoke'|'revalidate') => void): Promise<() => void>;
  prepare(group: ResourceGroup): Promise<GroupStamp>;
  catchUp(group?: ResourceGroup): Promise<void>;
  acceptCheck(input: ResourceGroup & {resourceId: string}, anchor: GroupAnchor): Promise<GroupAnchor>;
  granted(input: ResourceGroup & {resourceId: string}, anchor: GroupAnchor): Promise<GroupStamp>;
  guard(input: ResourceGroup & {resourceId: string}, stamp: GroupStamp): Promise<void>;
  guardMany(inputs: readonly {input:ResourceGroup & {resourceId:string};stamp:GroupStamp}[]):Promise<boolean[]>;
  stamp(group: ResourceGroup): Promise<GroupStamp>;
  close(): Promise<void>;
}

/** Runtime-neutral orchestration; the synchronous dispatch port executes real Rust. */
export function createDrivenResourceGroup(options: ResourceGroupOptions, dispatch: (request: unknown) => unknown): ResourceGroupCoordinator {
  const clone = options.clone ?? (<T>(v: T): T => JSON.parse(JSON.stringify(v)) as T);
  const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;
  if (!validId(options.namespace) || !options.storage || !options.purge) throw Error('group_config_invalid');
  const lease = options.ownerLeaseMs ?? 15000, interval = options.pollIntervalMs ?? 5000;
  if (!Number.isSafeInteger(lease) || lease < 1000 || lease > 60000 || !Number.isSafeInteger(interval) || interval < 0 || interval >= lease) throw Error('group_config_invalid');
  const owner = options.randomUUID();
  if (!validId(owner)) throw Error('group_config_invalid');
  type Entry = {group: ResourceGroup; key: string; tail: Promise<unknown>; polling?:Promise<void>; context?: string;
    listeners: Map<string, Set<(action: 'revoke'|'revalidate') => void>>; observed?: string};
  const groups = new Map<string, Entry>(), membership = new Map<string, string>();
  let closed = false, lastWall = -1;
  const clock = () => {
    const value = options.wall();
    if (!Number.isSafeInteger(value) || value < 0 || value < lastWall) throw Error('clock_discontinuity');
    lastWall = value; return value;
  };
  const entry = (input: ResourceGroup) => {
    if (closed) throw Error('context_changed');
    if (!input || !validId(input.binding) || !validId(input.resourceGroupId)) throw Error('group_identity_invalid');
    const group = {binding: input.binding, resourceGroupId: input.resourceGroupId};
    const key = JSON.stringify([options.namespace, 2, group.binding, group.resourceGroupId]);
    let e = groups.get(key);
    if (!e) {
      if (groups.size >= 64) throw Error('group_capacity');
      e = {group, key, tail: Promise.resolve(), listeners: new Map()}; groups.set(key, e);
    }
    return e;
  };
  const current = async (e: Entry) => {
    const actor = clone(await options.session());
    if (closed || actor.binding !== e.group.binding || !validId(actor.context) || !Number.isSafeInteger(actor.expiresAtMs) || actor.expiresAtMs <= clock() || e.context && e.context !== actor.context) throw Error('context_changed');
    e.context ??= actor.context; return actor;
  };
  const rust = (op: string, fields: Record<string, unknown>): GroupCheckpoint => dispatch({op, ...fields}) as GroupCheckpoint;
  const stateOf = (e: Entry, row: GroupRow|null): GroupCheckpoint => {
    if (!row?.state || row.state.binding !== e.group.binding || row.state.resourceGroupId !== e.group.resourceGroupId) throw Error('group_revalidation_required');
    // The Rust guard validates the entire persisted checkpoint, even when no Resource is resident.
    dispatch({op: 'guard', state: row.state, resourceId: '', generation: row.state.generation});
    if (!/^(0|[1-9][0-9]*)$/.test(row.term) || BigInt(row.term) > 18446744073709551615n) throw Error('group_state_invalid');
    if(row.owner&&(!validId(row.owner.id)||!validId(row.owner.context)||!Number.isSafeInteger(row.owner.until)||row.owner.until<0))throw Error('group_state_invalid');
    return row.state;
  };
  const makeStamp = (e: Entry, row: GroupRow): GroupStamp => {
    const s = stateOf(e, row);return {...e.group, generation: s.generation, term: row.term, epoch: s.epoch, sequence: s.sequence};
  };
  const observed = (e: Entry, state: GroupCheckpoint, term:string) => {
    const fence=JSON.stringify([term,state.generation]);
    if (e.observed === fence) return;
    e.observed = fence;
    for (const [id, listeners] of e.listeners) {
      // Another process's fresh grant cannot revive this process's old permit or display.
      const action = state.resources[id]?.intent ?? 'revalidate';
      for (const listener of listeners) { try { listener(action); } catch { /* Store fence remains authoritative. */ } }
    }
  };
  const announce = (e: Entry, row: GroupRow) => {
    const state = stateOf(e, row);observed(e, state,row.term);
    try { void Promise.resolve(options.notify?.({schemaVersion: 1, namespace: options.namespace, ...e.group, term: row.term, revision: state.revision})).catch(() => {}); } catch { /* Wakeups cannot change decisions. */ }
  };
  const serial = <T>(e: Entry, work: () => Promise<T>): Promise<T> => {
    const task = e.tail.then(work);e.tail = task.catch(() => {});return task;
  };
  const owned = (e: Entry, row: GroupRow|null, term: string) => {
    if (!row?.owner || row.owner.id !== owner || row.owner.context !== e.context || row.term !== term || row.owner.until <= clock()) throw Error('group_owner_changed');
  };
  const claim = async (e: Entry): Promise<string|null> => {
    const actor = await current(e), now = clock();
    return options.storage.transaction(e.key, saved => {
      if (closed) throw Error('context_changed');
      const row = clone(saved ?? {term: '0', owner: null, state: null});
      if (row.owner && row.owner.until > now && (row.owner.id !== owner || row.owner.context !== actor.context)) return {row, result: null};
      if (!row.owner || row.owner.until <= now || row.owner.id !== owner || row.owner.context !== actor.context) {
        const next = BigInt(row.term) + 1n;if (next > 18446744073709551615n) throw Error('group_capacity');row.term = String(next);
      }
      row.owner = {id: owner, context: actor.context, until: Math.min(now + lease, actor.expiresAtMs)};
      return {row, result: row.term};
    });
  };
  const update = async (e: Entry, term: string, work: (state: GroupCheckpoint|null) => GroupCheckpoint) => {
    await current(e);
    const row = await options.storage.transaction(e.key, saved => {
      owned(e, saved, term);const row = clone(saved!);row.state = work(row.state);return {row, result: row};
    });
    await current(e);announce(e, row);return row;
  };
  const subscribe = async (e: Entry, term: string) => {
    const requestId = options.randomUUID(), reply = await options.transport.subscribe(e.group, requestId);
    await current(e);
    if (reply.status !== 200) throw Error('group_subscribe_failed');
    const body = await reply.json() as any;await current(e);
    if (body?.schemaVersion !== 2 || body.kind !== 'resource_group' || body.requestId !== requestId || body.binding !== e.group.binding || body.resourceGroupId !== e.group.resourceGroupId) throw Error('group_response_invalid');
    return update(e, term, state => state ? rust('reset', {state, position: body.position}) : rust('initialize', {identity: e.group, position: body.position}));
  };
  const fence = (e: Entry, term: string) => update(e, term, state => {
    if (!state) throw Error('group_revalidation_required');return rust('fence', {state});
  });
  const recover = async (e: Entry, term: string) => {
    const row = await options.storage.read(e.key), state = stateOf(e, row);owned(e, row, term);
    for (const [resourceId, r] of Object.entries(state.resources)) {
      if (!r.intent) continue;
      const expected = makeStamp(e, row!);
      try {
        const assertCurrent = async () => {
          await current(e);const latest = await options.storage.read(e.key);owned(e, latest, term);
          const s = stateOf(e, latest);
          if (s.generation !== expected.generation || s.resources[resourceId]?.grantGeneration !== null || s.resources[resourceId]?.intent !== r.intent) throw Error('group_check_raced');
        };
        await assertCurrent();
        const outcome = await options.purge({...e.group, resourceId, action: r.intent, expected, assertCurrent});
        if (outcome?.status === 'blocked') continue;
        if (outcome?.status !== 'purged') throw Error('group_purge_invalid');
        await assertCurrent();
        await update(e, term, state => rust('purged', {state, resourceId, generation: expected.generation}));
      } catch { /* Intent is durable; one blocked/failed Resource must not stall the feed. */ }
    }
  };
  const pull = async (e: Entry) => {
    const term = await claim(e);if (term === null) { const row=await options.storage.read(e.key);observed(e,stateOf(e,row),row!.term);return; }
    let row = await options.storage.read(e.key);
    if (!row?.state) row = await subscribe(e, term);
    await recover(e, term);
    for (let page = 0; page < 32; page++) {
      row = await options.storage.read(e.key);const state = stateOf(e, row);owned(e, row, term);
      const requestId = options.randomUUID();let reply: Reply;
      try { reply = await options.transport.fetch(e.group, {requestId, cursor: state.cursor}); }
      catch (error) { if (!(error instanceof TypeError || (error as Error)?.name === 'TimeoutError')) await fence(e,term);throw error; }
      await current(e);
      if (reply.status === 409) { await fence(e,term);await subscribe(e,term);return; }
      if (reply.status !== 200) { await fence(e,term);throw Error('group_fetch_failed'); }
      try {
        const body = await reply.json() as any;await current(e);
        if (body?.schemaVersion !== 2 || body.kind !== 'resource_group' || body.requestId !== requestId || typeof body.hasMore !== 'boolean') throw Error('group_response_invalid');
        await update(e, term, latest => {
          if (latest?.epoch !== state.epoch || latest.sequence!==state.sequence || latest.cursor!==state.cursor) throw Error('group_check_raced');return rust('changes', {state: latest, batch: body.batch});
        });
        await recover(e, term);
        if (!body.hasMore) return;
        if (body.batch.throughSequence === body.batch.fromSequence) throw Error('group_response_invalid');
      } catch (error) { await fence(e,term);throw error; }
    }
    throw Error('group_page_limit');
  };
  const api: ResourceGroupCoordinator = {
    async prepare(group) {
      const e = entry(group);await current(e);
      if (!(await options.storage.read(e.key))?.state) await serial(e, () => pull(e));
      return api.stamp(group);
    },
    async register(input, invalidate) {
      const copy = clone(input);if (!validId(copy.resourceId)) throw Error('group_resource_invalid');const e = entry(copy);
      const identity=JSON.stringify([copy.binding,copy.resourceId]), previous=membership.get(identity);
      if (previous && previous!==e.key) throw Error('group_membership_changed');
      if (!previous && membership.size>=64) throw Error('group_capacity');
      await api.prepare(copy);await current(e);
      const registered=await options.storage.transaction(e.key, saved => {
        const state=stateOf(e,saved),row=clone(saved!);row.state=rust('register',{state,resourceId:copy.resourceId});return {row,result:row};
      });
      observed(e,stateOf(e,registered),registered.term);
      membership.set(identity,e.key);
      let listeners=e.listeners.get(copy.resourceId);if(!listeners){listeners=new Set();e.listeners.set(copy.resourceId,listeners);}
      if(listeners.size>=64)throw Error('group_capacity');
      const listener=invalidate??(()=>{});listeners.add(listener);
      return () => {listeners!.delete(listener);if(!listeners!.size){e.listeners.delete(copy.resourceId);membership.delete(identity);}};
    },
    async catchUp(group) {
      const entries=group?[entry(group)]:[...groups.values()];
      for(const e of entries){
        if(e.polling){await e.polling;continue;}
        const task=serial(e,()=>pull(e));e.polling=task;try{await task;}finally{if(e.polling===task)e.polling=undefined;}
      }
    },
    async acceptCheck(input, anchor) {
      const copy=clone(anchor), e=entry(input);await current(e);
      if (!copy || copy.resourceGroupId!==input.resourceGroupId) throw Error('group_membership_changed');
      await api.catchUp(input);const state=stateOf(e,await options.storage.read(e.key));
      // Rust validates canonical sequences, exact identity and the server watermark; this does not commit a grant.
      rust('grant',{state,resourceId:input.resourceId,anchor:copy});return copy;
    },
    async granted(input, anchor) {
      const e=entry(input);await current(e);
      const row=await options.storage.transaction(e.key,saved=>{
        const state=stateOf(e,saved),row=clone(saved!);row.state=rust('grant',{state,resourceId:input.resourceId,anchor});return {row,result:row};
      });await current(e);return makeStamp(e,row);
    },
    async stamp(group) {const e=entry(group);await current(e);const row=await options.storage.read(e.key);await current(e);return makeStamp(e,row!);},
    async guard(input, stamp) {
      const e=entry(input);await current(e);const row=await options.storage.read(e.key);await current(e);
      const state=stateOf(e,row);observed(e,state,row!.term);
      if (!stamp || stamp.binding!==input.binding || stamp.resourceGroupId!==input.resourceGroupId || stamp.epoch!==state.epoch || stamp.term!==row!.term
        || dispatch({op:'guard',state,resourceId:input.resourceId,generation:stamp.generation})!==true) throw Error('group_revalidation_required');
    },
    async guardMany(inputs){
      const copies=clone(inputs),entries=copies.map(value=>entry(value.input));
      for(const e of new Set(entries))await current(e);
      const rows=await options.storage.readMany(entries.map(e=>e.key));
      if(closed||rows.length!==entries.length)throw Error('context_changed');
      return copies.map(({input,stamp},index)=>{
        const e=entries[index]!,state=stateOf(e,rows[index]!);observed(e,state,rows[index]!.term);
        return !!stamp&&stamp.binding===input.binding&&stamp.resourceGroupId===input.resourceGroupId&&stamp.epoch===state.epoch&&stamp.term===rows[index]!.term&&dispatch({op:'guard',state,resourceId:input.resourceId,generation:stamp.generation})===true;
      });
    },
    async close() {
      if(closed)return;closed=true;clearInterval(timer);off?.();
      await Promise.allSettled([...groups.values()].map(async e=>{await options.storage.transaction(e.key,saved=>{
        const row=clone(saved??{term:'0',owner:null,state:null});if(row.owner?.id===owner)row.owner=null;return {row,result:null};
      });}));groups.clear();membership.clear();
    },
  };
  const off=options.listen?.(notice=>{
    const n=notice as Partial<GroupNotice>;
    if(closed||n?.schemaVersion!==1||n.namespace!==options.namespace||!validId(n.binding)||!validId(n.resourceGroupId))return;
    const key=JSON.stringify([options.namespace,2,n.binding,n.resourceGroupId]),e=groups.get(key);if(!e)return;
    void current(e).then(()=>options.storage.read(key)).then(row=>observed(e,stateOf(e,row),row!.term)).catch(()=>{
      for(const listeners of e.listeners.values())for(const listener of listeners){try{listener('revalidate');}catch{}}
    });
  });
  const timer=interval?setInterval(()=>{void api.catchUp().catch(()=>{});},interval):undefined;
  (timer as unknown as {unref?():void})?.unref?.();return api;
}
