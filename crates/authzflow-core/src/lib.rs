mod decision;
mod model;
pub use decision::evaluate;
pub use model::*;
mod transition;
pub use transition::{Plan, committed, prepare_snapshot};
mod api;
pub use api::dispatch;
mod changes;
pub use changes::{Batch, prepare_changes};

const MAX_RUNTIME_JSON: usize = 1_048_576;
const MAX_RUNTIME_ENTRIES: usize = 16_384;
static NEXT_RUNTIME: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

struct PendingTransition {
    id: String,
    next: Checkpoint,
}

/// Owns authorization state; only durable acknowledgement can enter Ready.
pub struct OwnedRuntime {
    state: Checkpoint,
    pending: Option<PendingTransition>,
    instance: u64,
    transition: u64,
    last_clock: Option<Clock>,
}

impl OwnedRuntime {
    fn parse<T: serde::de::DeserializeOwned>(input: &str) -> Result<T, String> {
        if input.len() > MAX_RUNTIME_JSON {
            return Err("invalid_request".into());
        }
        serde_json::from_str(input).map_err(|_| "invalid_request".into())
    }
    fn capacity(state: &Checkpoint) -> Result<(), String> {
        if state.resources.len() + state.scopes.len() > MAX_RUNTIME_ENTRIES
            || serde_json::to_string(state)
                .map_err(|_| "invalid_response")?
                .len()
                > MAX_RUNTIME_JSON
        {
            return Err("runtime_capacity".into());
        }
        Ok(())
    }
    pub fn new(input: &str) -> Result<Self, String> {
        let mut state: Checkpoint = Self::parse(input)?;
        Self::capacity(&state)?;
        state.phase = Phase::ResyncRequired;
        let mut ready = state.clone();
        ready.phase = Phase::Ready;
        let _ = prepare_snapshot(&state, &ready)?;
        let instance = NEXT_RUNTIME
            .fetch_update(
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
                |n| n.checked_add(1),
            )
            .map_err(|_| "runtime_capacity")?;
        Ok(Self {
            state,
            pending: None,
            instance,
            transition: 0,
            last_clock: None,
        })
    }
    fn clock(&mut self, input: &str) -> Result<Clock, String> {
        if self.state.phase == Phase::Closed {
            return Err("runtime_unavailable".into());
        }
        let clock: Clock = match Self::parse(input) {
            Ok(value) => value,
            Err(error) => {
                self.fence();
                return Err(error);
            }
        };
        if clock.boot.is_empty()
            || self
                .last_clock
                .as_ref()
                .is_some_and(|last| clock.boot != last.boot || clock.now_ms < last.now_ms)
        {
            self.fence();
            return Err("clock_discontinuity".into());
        }
        self.last_clock = Some(clock.clone());
        Ok(clock)
    }
    fn resources(input: &str) -> Result<Vec<String>, String> {
        let ids: Vec<String> = Self::parse(input)?;
        if ids.len() > 1024 || ids.iter().any(String::is_empty) {
            return Err("invalid_request".into());
        }
        Ok(ids)
    }
    pub fn evaluate(
        &mut self,
        resource: &str,
        clock: &str,
        offline: bool,
    ) -> Result<String, String> {
        if resource.is_empty() || resource.len() > MAX_RUNTIME_JSON {
            return Err("invalid_request".into());
        }
        let clock = self.clock(clock)?;
        serde_json::to_string(&evaluate(&self.state, resource, &clock, offline))
            .map_err(|_| "invalid_response".into())
    }
    pub fn evaluate_many(
        &mut self,
        input: &str,
        clock: &str,
        offline: bool,
    ) -> Result<String, String> {
        let ids = Self::resources(input)?;
        let clock = self.clock(clock)?;
        let decisions: Vec<_> = ids
            .iter()
            .map(|id| evaluate(&self.state, id, &clock, offline))
            .collect();
        serde_json::to_string(&decisions).map_err(|_| "invalid_response".into())
    }
    /// Pending next state is consulted only for invalidation, never for reads.
    pub fn invalidated(
        &mut self,
        input: &str,
        clock: &str,
        offline: bool,
    ) -> Result<String, String> {
        let ids = Self::resources(input)?;
        let clock = self.clock(clock)?;
        let candidate = self
            .pending
            .as_ref()
            .map_or(&self.state, |pending| &pending.next);
        let denied: Vec<_> = ids
            .into_iter()
            .filter(|id| !evaluate(candidate, id, &clock, offline).allowed)
            .collect();
        serde_json::to_string(&denied).map_err(|_| "invalid_response".into())
    }
    fn stage(&mut self, result: Result<Plan, String>) -> Result<String, String> {
        let plan = match result {
            Ok(plan) => plan,
            Err(error) => {
                self.fence();
                return Err(error);
            }
        };
        if let Err(error) = Self::capacity(&plan.next) {
            self.fence();
            return Err(error);
        }
        self.transition = match self.transition.checked_add(1) {
            Some(value) => value,
            None => {
                self.fence();
                return Err("runtime_capacity".into());
            }
        };
        let id = format!("{}:{}", self.instance, self.transition);
        #[derive(serde::Serialize)]
        struct Prepared<'a> {
            transition_id: &'a str,
            plan: &'a Plan,
        }
        let output = match serde_json::to_string(&Prepared {
            transition_id: &id,
            plan: &plan,
        }) {
            Ok(output) => output,
            Err(_) => {
                self.fence();
                return Err("invalid_response".into());
            }
        };
        self.state = plan.pending;
        self.pending = Some(PendingTransition {
            id,
            next: plan.next,
        });
        Ok(output)
    }
    fn can_prepare(&self) -> Result<(), String> {
        if self.state.phase == Phase::Closed {
            return Err("runtime_unavailable".into());
        }
        if self.pending.is_some() {
            return Err("commit_in_progress".into());
        }
        Ok(())
    }
    pub fn prepare_snapshot(&mut self, input: &str) -> Result<String, String> {
        self.can_prepare()?;
        let result = Self::parse::<Checkpoint>(input)
            .and_then(|incoming| prepare_snapshot(&self.state, &incoming));
        self.stage(result)
    }
    pub fn prepare_changes(&mut self, input: &str) -> Result<String, String> {
        self.can_prepare()?;
        let result =
            Self::parse::<Batch>(input).and_then(|batch| prepare_changes(&self.state, &batch));
        self.stage(result)
    }
    pub fn acknowledge(&mut self, id: &str, saved_revision: &str) -> Result<(), String> {
        if self.state.phase == Phase::Closed {
            return Err("runtime_unavailable".into());
        }
        let pending = match self.pending.take() {
            Some(pending) => pending,
            None => {
                self.fence();
                return Err("commit_mismatch".into());
            }
        };
        if pending.id != id {
            self.state = pending.next;
            self.fence();
            return Err("commit_mismatch".into());
        }
        let plan = Plan {
            expected_revision: self.state.revision.clone(),
            pending: self.state.clone(),
            next: pending.next,
        };
        match committed(&plan, saved_revision) {
            Ok(next) => {
                self.state = next;
                Ok(())
            }
            Err(error) => {
                self.state = plan.next;
                self.fence();
                Err(error)
            }
        }
    }
    pub fn fence(&mut self) {
        if self.state.phase == Phase::Closed {
            return;
        }
        if let Some(pending) = self.pending.take() {
            self.state = pending.next;
        }
        self.state.phase = Phase::ResyncRequired;
    }
    pub fn close(&mut self) {
        self.fence();
        self.state.phase = Phase::Closed;
        self.pending = None;
        self.state.resources.clear();
        self.state.scopes.clear();
        self.state.cursor.clear();
        self.last_clock = None;
    }
    pub fn snapshot(&self) -> Result<String, String> {
        serde_json::to_string(&self.state).map_err(|_| "invalid_response".into())
    }
    pub fn phase(&self) -> String {
        match self.state.phase {
            Phase::Uninitialized => "uninitialized",
            Phase::Ready => "ready",
            Phase::CommitPending => "commit_pending",
            Phase::ResyncRequired => "resync_required",
            Phase::Closed => "closed",
        }
        .into()
    }
}
