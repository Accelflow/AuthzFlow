import type { Checkpoint, Clock, Plan, Runtime, RuntimeEvent } from './index.js';

export interface CheckedReaderOptions<T> {
  binding: string;
  resourceId: string;
  scopeId: string;
  session(): Promise<{ binding: string; context: string; expiresAtMs: number }>;
  clock(): Clock & { wall_ms: number };
  storage: { load(binding: string): Promise<Checkpoint | null>; commit(plan: Plan): Promise<string> };
  check(input: { requestId: string }): Promise<{ status: number; json(): Promise<unknown> }>;
  read(): Promise<T>;
  contentHash(value: T): Promise<string>;
  wasmBytes?: Uint8Array<ArrayBuffer>;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
}
export interface CheckedRead<T> { readonly value: T; readonly validForMs: number; readonly expiresAtMs: number; readonly offline: boolean }
export interface CheckedReader<T> { read(): Promise<T>; readWithPermit(): Promise<CheckedRead<T>>; readCachedWithPermit(): Promise<CheckedRead<T>>; close(): void }
export type ReaderRuntime = Pick<Runtime,'applySnapshot'|'get'|'snapshot'|'close'>;
export interface ProtocolReaderOptions<T> extends CheckedReaderOptions<T> {
 createRuntime(input:{checkpoint:Checkpoint;clock:()=>Clock;commit:(plan:Plan)=>Promise<string>;wasmBytes?:Uint8Array<ArrayBuffer>;onEvent?:CheckedReaderOptions<T>['onEvent']}):Promise<ReaderRuntime>;
 clone<V>(value:V):V;
 randomUUID():string;
}
export async function createProtocolCheckedReader<T>(options: ProtocolReaderOptions<T>): Promise<CheckedReader<T>> {
  const { binding, resourceId, scopeId, storage, wasmBytes, onEvent } = options;
  if ([binding, resourceId, scopeId].some(x => typeof x !== 'string' || !x || x.length > 4096)) throw Error('authz_reader_config_invalid');
  let closed = false, busy = false, generation = 0, live: ReaderRuntime | undefined;
  let last: ReturnType<typeof options.clock> | undefined;
  type Permit = { runtime: ReaderRuntime; context: string; epoch: string; revision: string; hash: string; start: ReturnType<typeof options.clock>; duration: number; sessionExpiry: number };
  let permit: Permit | undefined;
  let delivered: { grant: Permit; offline: boolean } | undefined;
  const sample = () => {
    const s = { ...options.clock() };
    if (!s.boot || !Number.isSafeInteger(s.now_ms) || s.now_ms < 0 || !Number.isSafeInteger(s.wall_ms) || s.wall_ms < 0
      || last && (last.boot !== s.boot || s.now_ms < last.now_ms || s.wall_ms < last.wall_ms)) throw Error('clock_discontinuity');
    last = s; return s;
  };
  const clear = () => { live?.close(); if (permit?.runtime !== live) permit?.runtime.close(); live = undefined; permit = undefined; delivered = undefined; };
  const coreClock = () => { const { boot, now_ms } = sample(); return { boot, now_ms }; };
  const reader: CheckedReader<T> = {
    async read() {
      if (closed) throw Error('runtime_unavailable');
      if (busy) throw Error('check_in_progress');
      busy = true;
      const turn = ++generation;
      try {
        const actor = { ...await options.session() }, start = sample();
        if (actor.binding !== binding || !actor.context || !Number.isSafeInteger(actor.expiresAtMs) || actor.expiresAtMs <= start.wall_ms) throw Error('context_changed');
        const ensure = async () => {
          const current = await options.session();
          if (closed || turn !== generation || current.binding !== binding || current.context !== actor.context
            || !Number.isSafeInteger(current.expiresAtMs) || sample().wall_ms >= Math.min(actor.expiresAtMs, current.expiresAtMs)) throw Error('context_changed');
        };
        const saved = await storage.load(binding); await ensure();
        if (saved && saved.binding !== binding) throw Error('context_changed');
        const remaining = (p: Permit) => {
          const now = sample();
          return Math.min(p.start.now_ms + p.duration - now.now_ms, p.start.wall_ms + p.duration - now.wall_ms, p.sessionExpiry - now.wall_ms);
        };
        const readValue = async (p: Permit, offline: boolean) => {
          if (remaining(p) <= 0) throw Error('authz_offline_expired');
          const value = await p.runtime.get(resourceId, async () => {
            const value = options.clone(await options.read()); await ensure();
            const hash = await options.contentHash(value); await ensure();
            if (hash !== p.hash) throw Error('authz_content_changed');
            if (remaining(p) <= 0) throw Error('authz_offline_expired');
            return value;
          }, offline);
          await ensure(); if (remaining(p) <= 0) throw Error('authz_offline_expired');
          delivered = { grant: p, offline };
          return value;
        };
        const requestId = options.randomUUID();
        let response: Awaited<ReturnType<typeof options.check>>;
        try { response = await options.check({ requestId }); }
        catch (error) {
          await ensure();
          if (!(error instanceof TypeError || error instanceof Error && error.name === 'TimeoutError') || !permit
            || permit.context !== actor.context || permit.epoch !== saved?.epoch || permit.revision !== saved?.revision || remaining(permit) <= 0) throw Error('authz_offline_expired');
          return await readValue(permit, true);
        }
        await ensure(); clear();
        const commit = async (plan: Plan) => { await ensure(); const revision = await storage.commit(plan); await ensure(); return revision; };
        if ([401, 403, 404].includes(response.status)) {
          const base: Checkpoint = saved ?? {schema_version:1,binding,epoch:'denied',sequence:'0',revision:'0',cursor:'',phase:'uninitialized',resources:{},scopes:{}};
          live = await options.createRuntime({checkpoint:base,clock:coreClock,commit,wasmBytes,onEvent}); await ensure();
          const denied=options.clone(base);denied.phase='ready';
          denied.resources[resourceId]={access:'deny',version:'0',expires_at_ms:0,offline:false,boot:start.boot,scopes:[],stale:false};
          await live.applySnapshot(denied); await ensure();
          throw Error('authz_check_denied');
        }
        if (response.status !== 200) throw Error('authz_check_unavailable');
        const body = await response.json() as { schemaVersion: number; mode: string; requestId: string; binding: string; resourceId: string; scopeId: string; epoch: string; contentHash: string; leaseMs: number; readPolicy: { mode: string; maxOfflineMs: number } };
        await ensure();
        if (!body || body.schemaVersion !== 1 || body.mode !== 'check_only' || body.requestId !== requestId || body.binding !== binding
          || body.resourceId !== resourceId || body.scopeId !== scopeId || typeof body.epoch !== 'string' || !body.epoch || body.epoch.length > 128
          || typeof body.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.contentHash)
          || !Number.isSafeInteger(body.leaseMs) || body.leaseMs <= 0 || body.leaseMs > 5000) throw Error('authz_check_invalid');
        const policy = body.readPolicy;
        if (!policy || Array.isArray(policy) || Object.keys(policy).length !== 2 || !Number.isSafeInteger(policy.maxOfflineMs)
          || !(policy.mode === 'online_only' && policy.maxOfflineMs === 0 || policy.mode === 'offline_ttl' && policy.maxOfflineMs > 0 && policy.maxOfflineMs <= 86400000)) throw Error('authz_check_invalid');
        const duration = Math.min(policy.mode === 'offline_ttl' ? policy.maxOfflineMs : body.leaseMs, actor.expiresAtMs - start.wall_ms);
        const now = sample();
        if (now.now_ms - start.now_ms >= body.leaseMs || now.wall_ms - start.wall_ms >= body.leaseMs) throw Error('authz_check_invalid');
        const initial: Checkpoint = { schema_version: 1, binding, epoch: body.epoch, sequence: '0', revision: saved?.revision ?? '0', cursor: '', phase: 'uninitialized', resources: {}, scopes: {} };
        const entry = { access: 'allow' as const, version: '0', expires_at_ms: start.now_ms + duration, offline: policy.mode === 'offline_ttl', boot: start.boot, scopes: [] as string[], stale: false };
        const fresh: Checkpoint = { ...initial, phase: 'ready', resources: { [resourceId]: { ...entry, scopes: [scopeId] } }, scopes: { [scopeId]: entry } };
        live = await options.createRuntime({ checkpoint: initial, clock: coreClock, commit, wasmBytes, onEvent }); await ensure();
        await live.applySnapshot(fresh); await ensure();
        const next = { runtime: live, context: actor.context, epoch: body.epoch, revision: live.snapshot().revision, hash: body.contentHash, start, duration, sessionExpiry: actor.expiresAtMs };
        const value = await readValue(next, false);
        if (policy.mode === 'offline_ttl') permit = next;
        return value;
      } catch (error) { clear(); throw error; }
      finally { busy = false; }
    },
    async readWithPermit() {
      const expected = generation + 1, value = await reader.read();
      try {
        if (closed || generation !== expected || !delivered) throw Error('context_changed');
        const { grant: p, offline } = delivered, now = sample();
        const validForMs = Math.min(p.start.now_ms + p.duration - now.now_ms, p.start.wall_ms + p.duration - now.wall_ms, p.sessionExpiry - now.wall_ms);
        if (validForMs <= 0) throw Error('authz_offline_expired');
        return Object.freeze({ value, validForMs, expiresAtMs: now.wall_ms + validForMs, offline });
      } catch (error) { clear(); throw error; }
    },
    async readCachedWithPermit() {
      if(closed)throw Error('runtime_unavailable');
      if(busy)throw Error('check_in_progress');
      if(!permit)throw Error('authz_cached_permit_missing');
      busy=true;const p=permit,turn=++generation;
      const ensure=async()=>{const actor=await options.session();if(closed||generation!==turn||actor.binding!==binding||actor.context!==p.context||!Number.isSafeInteger(actor.expiresAtMs)||sample().wall_ms>=Math.min(p.sessionExpiry,actor.expiresAtMs))throw Error('context_changed');};
      const remaining=()=>{const now=sample();return Math.min(p.start.now_ms+p.duration-now.now_ms,p.start.wall_ms+p.duration-now.wall_ms,p.sessionExpiry-now.wall_ms);};
      try{
        await ensure();const saved=await storage.load(binding);await ensure();
        if(saved?.binding!==binding||saved.epoch!==p.epoch||saved.revision!==p.revision)throw Error('context_changed');
        if(remaining()<=0)throw Error('authz_offline_expired');
        const value=await p.runtime.get(resourceId,async()=>{
          const value=options.clone(await options.read());await ensure();const hash=await options.contentHash(value);await ensure();
          if(hash!==p.hash)throw Error('authz_content_changed');if(remaining()<=0)throw Error('authz_offline_expired');return value;
        },true);
        await ensure();const now=sample(),validForMs=Math.min(p.start.now_ms+p.duration-now.now_ms,p.start.wall_ms+p.duration-now.wall_ms,p.sessionExpiry-now.wall_ms);if(validForMs<=0)throw Error('authz_offline_expired');
        return Object.freeze({value,validForMs,expiresAtMs:Math.min(p.start.wall_ms+p.duration,p.sessionExpiry,now.wall_ms+validForMs),offline:true});
      }catch(error){if(!(error instanceof Error)||error.message!=='authz_content_changed')clear();throw error;}
      finally{busy=false;}
    },
    close() { closed = true; generation++; clear(); },
  };
  return reader;
}
