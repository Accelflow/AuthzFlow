use crate::transition::number;
use crate::{Access, Checkpoint, Entry, Phase, Plan, prepare_snapshot};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub binding: String,
    pub epoch: String,
    pub from_sequence: String,
    pub through_sequence: String,
    pub next_cursor: String,
    pub changes: Vec<Change>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub sequence: String,
    pub target: Target,
    pub action: Action,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub kind: Kind,
    pub id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Resource,
    Scope,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Revoke,
    Revalidate,
    Invalidate,
    Purge,
    Grant,
}

/// A complete, host-authenticated change batch. GRANT requires a fresh check.
pub fn prepare_changes(state: &Checkpoint, batch: &Batch) -> Result<Plan, String> {
    if state.phase != Phase::Ready {
        return Err("revalidation_required".into());
    }
    if batch.binding != state.binding || batch.epoch != state.epoch {
        return Err("context_changed".into());
    }
    let from = number(&batch.from_sequence)?;
    let through = number(&batch.through_sequence)?;
    let current = number(&state.sequence)?;
    if through == current && from <= current && batch.next_cursor == state.cursor {
        return prepare_snapshot(state, state);
    }
    if from != current || through < from || batch.next_cursor.is_empty() {
        return Err("cursor_reset_required".into());
    }
    let mut next = state.clone();
    let mut previous = from;
    for event in &batch.changes {
        let sequence = number(&event.sequence)?;
        if sequence <= previous || sequence > through || event.target.id.is_empty() {
            return Err("invalid_event_order".into());
        }
        previous = sequence;
        let entries = match event.target.kind {
            Kind::Resource => &mut next.resources,
            Kind::Scope => &mut next.scopes,
        };
        let entry = entries
            .entry(event.target.id.clone())
            .or_insert_with(|| Entry {
                access: Access::Revalidate,
                version: event.sequence.clone(),
                expires_at_ms: 0,
                offline: false,
                boot: String::new(),
                scopes: vec![],
                stale: true,
            });
        match event.action {
            Action::Invalidate => entry.stale = true,
            Action::Revoke | Action::Purge => {
                entry.access = Access::Deny;
                entry.version = event.sequence.clone();
            }
            Action::Revalidate | Action::Grant => {
                entry.access = Access::Revalidate;
                entry.version = event.sequence.clone();
                entry.expires_at_ms = 0;
            }
        }
    }
    next.sequence = batch.through_sequence.clone();
    next.cursor = batch.next_cursor.clone();
    prepare_snapshot(state, &next)
}
