use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    binding: String,
    resource_group_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    epoch: String,
    sequence: String,
    cursor: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Action {
    Revoke,
    Revalidate,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resource {
    grant_generation: Option<String>,
    intent: Option<Action>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    schema_version: u32,
    kind: String,
    binding: String,
    resource_group_id: String,
    epoch: String,
    sequence: String,
    cursor: String,
    generation: String,
    revision: String,
    resources: BTreeMap<String, Resource>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Anchor {
    resource_group_id: String,
    epoch: String,
    sequence: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Event {
    sequence: String,
    action: Action,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Batch {
    binding: String,
    resource_group_id: String,
    epoch: String,
    from_sequence: String,
    through_sequence: String,
    next_cursor: String,
    changes: Vec<Event>,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Initialize {
        identity: Identity,
        position: Position,
    },
    Register {
        state: State,
        #[serde(rename = "resourceId")]
        resource_id: String,
    },
    Changes {
        state: State,
        batch: Batch,
    },
    Reset {
        state: State,
        position: Position,
    },
    Fence {
        state: State,
    },
    Grant {
        state: State,
        #[serde(rename = "resourceId")]
        resource_id: String,
        anchor: Anchor,
    },
    Guard {
        state: State,
        #[serde(rename = "resourceId")]
        resource_id: String,
        generation: String,
    },
    Purged {
        state: State,
        #[serde(rename = "resourceId")]
        resource_id: String,
        generation: String,
    },
}

/// Independent protocol v2 entry. Never evaluates or grants Resource content.
pub fn dispatch_group(input: &str) -> Result<String, String> {
    if input.len() > 1_048_576 {
        return Err("group_capacity".into());
    }
    let request: Request = serde_json::from_str(input).map_err(|_| "group_request_invalid")?;
    let text = |s: &str, max: usize| !s.is_empty() && s.len() <= max;
    let number = |s: &str| -> Result<u64, String> {
        let n = s.parse::<u64>().map_err(|_| "group_sequence_invalid")?;
        if n.to_string() != s {
            return Err("group_sequence_invalid".into());
        }
        Ok(n)
    };
    let bump = |s: &str| -> Result<String, String> {
        number(s)?
            .checked_add(1)
            .map(|n| n.to_string())
            .ok_or_else(|| "group_capacity".into())
    };
    let validate = |s: &State| -> Result<(), String> {
        if s.schema_version != 2
            || s.kind != "resource_group"
            || !text(&s.binding, 4096)
            || !text(&s.resource_group_id, 4096)
            || !text(&s.epoch, 128)
            || !text(&s.cursor, 8192)
            || s.resources.len() > 64
            || s.resources.keys().any(|id| !text(id, 4096))
        {
            return Err("group_state_invalid".into());
        }
        number(&s.sequence)?;
        number(&s.revision)?;
        number(&s.generation)?;
        for r in s.resources.values() {
            if let Some(g) = &r.grant_generation
                && number(g)? > number(&s.generation)?
            {
                return Err("group_state_invalid".into());
            }
        }
        Ok(())
    };
    let position = |p: &Position| -> Result<(), String> {
        if !text(&p.epoch, 128) || !text(&p.cursor, 8192) {
            return Err("group_position_invalid".into());
        }
        number(&p.sequence)?;
        Ok(())
    };
    let invalidate = |s: &mut State, action: Action| {
        for r in s.resources.values_mut() {
            r.grant_generation = None;
            if r.intent != Some(Action::Revoke) {
                r.intent = Some(action.clone());
            }
        }
    };
    let mut state = match request {
        Request::Initialize {
            identity,
            position: p,
        } => {
            position(&p)?;
            State {
                schema_version: 2,
                kind: "resource_group".into(),
                binding: identity.binding,
                resource_group_id: identity.resource_group_id,
                epoch: p.epoch,
                sequence: p.sequence,
                cursor: p.cursor,
                generation: "0".into(),
                revision: "0".into(),
                resources: BTreeMap::new(),
            }
        }
        Request::Guard {
            state,
            resource_id,
            generation,
        } => {
            validate(&state)?;
            let allowed = state.generation == generation
                && state
                    .resources
                    .get(&resource_id)
                    .is_some_and(|r| r.grant_generation.as_ref() == Some(&generation));
            return serde_json::to_string(&allowed).map_err(|_| "group_response_invalid".into());
        }
        Request::Register {
            mut state,
            resource_id,
        } => {
            validate(&state)?;
            if !text(&resource_id, 4096) {
                return Err("group_resource_invalid".into());
            }
            state.resources.entry(resource_id).or_insert(Resource {
                grant_generation: None,
                intent: None,
            });
            state
        }
        Request::Changes { mut state, batch } => {
            validate(&state)?;
            if batch.binding != state.binding
                || batch.resource_group_id != state.resource_group_id
                || batch.epoch != state.epoch
            {
                return Err("group_context_changed".into());
            }
            let mut sequence = number(&state.sequence)?;
            if number(&batch.from_sequence)? != sequence
                || batch.changes.len() > 100
                || !text(&batch.next_cursor, 8192)
            {
                return Err("group_reset_required".into());
            }
            for event in batch.changes {
                sequence = sequence.checked_add(1).ok_or("group_capacity")?;
                if number(&event.sequence)? != sequence {
                    return Err("group_reset_required".into());
                }
                state.generation = bump(&state.generation)?;
                invalidate(&mut state, event.action);
            }
            if number(&batch.through_sequence)? != sequence {
                return Err("group_reset_required".into());
            }
            state.sequence = batch.through_sequence;
            state.cursor = batch.next_cursor;
            state
        }
        Request::Reset {
            mut state,
            position: p,
        } => {
            validate(&state)?;
            position(&p)?;
            state.generation = bump(&state.generation)?;
            invalidate(&mut state, Action::Revalidate);
            state.epoch = p.epoch;
            state.sequence = p.sequence;
            state.cursor = p.cursor;
            state
        }
        Request::Fence { mut state } => {
            validate(&state)?;
            state.generation = bump(&state.generation)?;
            invalidate(&mut state, Action::Revalidate);
            state
        }
        Request::Grant {
            mut state,
            resource_id,
            anchor,
        } => {
            validate(&state)?;
            if anchor.resource_group_id != state.resource_group_id
                || anchor.epoch != state.epoch
                || anchor.sequence != state.sequence
            {
                return Err("group_check_raced".into());
            }
            let r = state
                .resources
                .get_mut(&resource_id)
                .ok_or("group_resource_missing")?;
            r.grant_generation = Some(state.generation.clone());
            r.intent = None;
            state
        }
        Request::Purged {
            mut state,
            resource_id,
            generation,
        } => {
            validate(&state)?;
            if generation != state.generation {
                return Err("group_check_raced".into());
            }
            let r = state
                .resources
                .get_mut(&resource_id)
                .ok_or("group_resource_missing")?;
            if r.grant_generation.is_some() {
                return Err("group_check_raced".into());
            }
            r.intent = None;
            state
        }
    };
    state.revision = bump(&state.revision)?;
    validate(&state)?;
    serde_json::to_string(&state).map_err(|_| "group_response_invalid".into())
}
