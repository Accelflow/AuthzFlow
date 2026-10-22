use crate::{Access, Checkpoint, Clock, Decision, Entry, Phase};

/// Evaluates an existing host-owned authorization checkpoint without I/O.
pub fn evaluate(state: &Checkpoint, resource: &str, clock: &Clock, offline: bool) -> Decision {
    // Helper to check if an entry is valid
    let is_entry_valid = |entry: &Entry| {
        entry.access == Access::Allow
            && !entry.stale
            && entry.boot == clock.boot
            && clock.now_ms < entry.expires_at_ms
            && (!offline || entry.offline)
    };

    // Check if the checkpoint is ready and the resource exists
    if state.schema_version != 1 || state.phase != Phase::Ready {
        return Decision {
            allowed: false,
            reason: "not_ready".into(),
        };
    }

    // Get the resource entry
    let resource_entry = match state.resources.get(resource) {
        Some(entry) => entry,
        None => {
            return Decision {
                allowed: false,
                reason: "resource_not_found".into(),
            };
        }
    };

    // Check if the resource entry is valid
    if !is_entry_valid(resource_entry) {
        return Decision {
            allowed: false,
            reason: "resource_invalid".into(),
        };
    }

    // Check all required scopes
    for scope_id in &resource_entry.scopes {
        let scope_entry = match state.scopes.get(scope_id) {
            Some(entry) => entry,
            None => {
                return Decision {
                    allowed: false,
                    reason: "scope_not_found".into(),
                };
            }
        };

        if !is_entry_valid(scope_entry) {
            return Decision {
                allowed: false,
                reason: "scope_invalid".into(),
            };
        }
    }

    // All checks passed
    Decision {
        allowed: true,
        reason: "allowed".into(),
    }
}
