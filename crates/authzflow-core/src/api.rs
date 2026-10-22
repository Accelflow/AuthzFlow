use crate::{Checkpoint, Clock, Phase, Plan};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    EvaluateMany {
        state: Checkpoint,
        resources: Vec<String>,
        clock: Clock,
        offline: bool,
    },
    Evaluate {
        state: Checkpoint,
        resource: String,
        clock: Clock,
        offline: bool,
    },
    Prepare {
        state: Checkpoint,
        incoming: Checkpoint,
    },
    Changes {
        state: Checkpoint,
        batch: crate::Batch,
    },
    Commit {
        plan: Plan,
        saved_revision: String,
    },
    Fence {
        state: Checkpoint,
        phase: Phase,
    },
}

/// A bounded, identical JSON entrypoint for native and WebAssembly consumers.
pub fn dispatch(input: &str) -> Result<String, String> {
    if input.len() > 1048576 {
        return Err("invalid_request".into());
    }
    let request: Request = serde_json::from_str(input).map_err(|_| "invalid_request")?;
    match request {
        Request::EvaluateMany {
            state,
            resources,
            clock,
            offline,
        } => {
            if resources.len() > 1024 || resources.iter().any(|r| r.is_empty()) {
                return Err("invalid_request".into());
            }
            let results: Vec<_> = resources
                .into_iter()
                .map(|id| crate::evaluate(&state, &id, &clock, offline))
                .collect();
            serde_json::to_string(&results).map_err(|_| "invalid_response".into())
        }
        Request::Evaluate {
            state,
            resource,
            clock,
            offline,
        } => {
            let result = crate::evaluate(&state, &resource, &clock, offline);
            serde_json::to_string(&result).map_err(|_| "invalid_response".into())
        }
        Request::Prepare { state, incoming } => {
            let result = crate::prepare_snapshot(&state, &incoming)?;
            serde_json::to_string(&result).map_err(|_| "invalid_response".into())
        }
        Request::Changes { state, batch } => {
            let result = crate::prepare_changes(&state, &batch)?;
            serde_json::to_string(&result).map_err(|_| "invalid_response".into())
        }
        Request::Commit {
            plan,
            saved_revision,
        } => {
            let result = crate::committed(&plan, &saved_revision)?;
            serde_json::to_string(&result).map_err(|_| "invalid_response".into())
        }
        Request::Fence { mut state, phase } => match phase {
            Phase::Closed | Phase::ResyncRequired => {
                state.phase = phase;
                serde_json::to_string(&state).map_err(|_| "invalid_response".into())
            }
            _ => Err("invalid_request".into()),
        },
    }
}
