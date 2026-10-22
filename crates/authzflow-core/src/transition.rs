use crate::{Access, Checkpoint, Entry, Phase};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub expected_revision: String,
    pub pending: Checkpoint,
    pub next: Checkpoint,
}

pub(crate) fn number(value: &str) -> Result<u64, String> {
    let parsed = value.parse::<u64>().map_err(|_| "invalid_version")?;
    if parsed.to_string() != value {
        return Err("noncanonical_version".into());
    }
    Ok(parsed)
}

fn validate(state: &Checkpoint) -> Result<(), String> {
    if state.schema_version != 1 || state.binding.is_empty() || state.epoch.is_empty() {
        return Err("invalid_context".into());
    }
    let seq = number(&state.sequence)?;
    number(&state.revision)?;
    for (id, entry) in state.resources.iter().chain(state.scopes.iter()) {
        if id.is_empty() || number(&entry.version)? > seq {
            return Err("invalid_entry".into());
        }
    }
    Ok(())
}

fn reconcile(
    old: &BTreeMap<String, Entry>,
    next: &mut BTreeMap<String, Entry>,
) -> Result<(), String> {
    for (id, previous) in old {
        let previous_version = number(&previous.version)?;
        if let Some(incoming) = next.get(id) {
            let version = number(&incoming.version)?;
            if version < previous_version {
                return Err("stale_entry".into());
            }
            if previous.access == Access::Deny
                && incoming.access == Access::Allow
                && version <= previous_version
            {
                return Err("stale_grant".into());
            }
        } else if previous.access != Access::Allow {
            next.insert(id.clone(), previous.clone());
        }
    }
    Ok(())
}

/// Builds a pending read fence and next checkpoint; no I/O is performed.
pub fn prepare_snapshot(current: &Checkpoint, incoming: &Checkpoint) -> Result<Plan, String> {
    validate(current)?;
    validate(incoming)?;
    if current.binding != incoming.binding || current.epoch != incoming.epoch {
        return Err("context_changed".into());
    }
    if matches!(current.phase, Phase::Closed | Phase::CommitPending)
        || incoming.phase != Phase::Ready
    {
        return Err("invalid_phase".into());
    }
    if number(&incoming.sequence)? < number(&current.sequence)? {
        return Err("stale_snapshot".into());
    }
    let mut next = incoming.clone();
    reconcile(&current.resources, &mut next.resources)?;
    reconcile(&current.scopes, &mut next.scopes)?;
    next.revision = number(&current.revision)?
        .checked_add(1)
        .ok_or("revision_overflow")?
        .to_string();
    let mut pending = current.clone();
    pending.phase = Phase::CommitPending;
    Ok(Plan {
        expected_revision: current.revision.clone(),
        pending,
        next,
    })
}

/// Host calls this only after its atomic durable compare-and-swap succeeds.
pub fn committed(plan: &Plan, saved_revision: &str) -> Result<Checkpoint, String> {
    validate(&plan.pending)?;
    validate(&plan.next)?;
    let next_revision = number(&plan.expected_revision)?
        .checked_add(1)
        .ok_or("revision_overflow")?;
    if saved_revision != plan.next.revision
        || number(saved_revision)? != next_revision
        || plan.pending.revision != plan.expected_revision
        || plan.pending.phase != Phase::CommitPending
        || plan.next.phase != Phase::Ready
        || plan.pending.binding != plan.next.binding
        || plan.pending.epoch != plan.next.epoch
    {
        return Err("commit_mismatch".into());
    }
    Ok(plan.next.clone())
}
