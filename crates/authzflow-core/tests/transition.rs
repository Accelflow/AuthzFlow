// Transactional snapshot ingestion regression anchor.

#[test]
fn snapshot_commit_boundary() {
    use authzflow_core::{Access, Checkpoint, Clock, Phase, committed, evaluate, prepare_snapshot};
    use serde_json::from_str;

    let current: Checkpoint = from_str(include_str!("../../../fixtures/ready.json")).unwrap();
    let mut incoming = current.clone();
    incoming.scopes.get_mut("scope").unwrap().access = Access::Deny;
    incoming.sequence = "2".to_string();
    incoming.cursor = "cursor-2".to_string();
    incoming.scopes.get_mut("scope").unwrap().version = "2".to_string();

    let plan = prepare_snapshot(&current, &incoming).expect("SNAPSHOT_PREPARE_MISSING");
    assert_eq!(plan.pending.phase, Phase::CommitPending);
    assert!(
        !evaluate(
            &plan.pending,
            "article",
            &Clock {
                boot: "boot".into(),
                now_ms: 50
            },
            false
        )
        .allowed
    );
    assert_eq!(plan.expected_revision, "1");
    assert!(committed(&plan, "wrong").is_err());
    let next = committed(&plan, "2").unwrap();
    assert_eq!(next.cursor, "cursor-2");
    assert!(
        !evaluate(
            &next,
            "article",
            &Clock {
                boot: "boot".into(),
                now_ms: 50
            },
            false
        )
        .allowed
    );
    assert!(prepare_snapshot(&next, &current).is_err());
}

#[test]
fn snapshot_cannot_resurrect_scope_or_resource() {
    use authzflow_core::{Access, Checkpoint, committed, prepare_snapshot};
    let base: Checkpoint =
        serde_json::from_str(include_str!("../../../fixtures/ready.json")).unwrap();
    for scope in [false, true] {
        let mut denied = base.clone();
        let entries = if scope {
            &mut denied.scopes
        } else {
            &mut denied.resources
        };
        entries.values_mut().next().unwrap().access = Access::Deny;
        assert!(
            prepare_snapshot(&denied, &base).is_err(),
            "equal-version deny must not be overwritten"
        );
        let mut missing = denied.clone();
        if scope {
            missing.scopes.clear();
        } else {
            missing.resources.clear();
        }
        let plan = prepare_snapshot(&denied, &missing).unwrap();
        let next = committed(&plan, "2").unwrap();
        let entries = if scope { &next.scopes } else { &next.resources };
        assert_eq!(
            entries.values().next().unwrap().access,
            Access::Deny,
            "omission must retain tombstone"
        );
        let mut grant = base.clone();
        grant.sequence = "2".into();
        if scope {
            grant.scopes.get_mut("scope").unwrap().version = "2".into();
        } else {
            grant.resources.get_mut("article").unwrap().version = "2".into();
        }
        let plan = prepare_snapshot(&denied, &grant).unwrap();
        let entries = if scope {
            &plan.next.scopes
        } else {
            &plan.next.resources
        };
        assert_eq!(
            entries.values().next().unwrap().access,
            Access::Allow,
            "new grant must be possible"
        );
    }
}

#[test]
fn rejects_noncanonical_and_future_versions() {
    use authzflow_core::{Checkpoint, prepare_snapshot};
    let base: Checkpoint =
        serde_json::from_str(include_str!("../../../fixtures/ready.json")).unwrap();
    for value in ["01", "+1", "-1", "", "18446744073709551616"] {
        let mut incoming = base.clone();
        incoming.sequence = value.into();
        assert!(
            prepare_snapshot(&base, &incoming).is_err(),
            "noncanonical sequence {value}"
        );
        let mut incoming = base.clone();
        incoming.scopes.get_mut("scope").unwrap().version = value.into();
        assert!(
            prepare_snapshot(&base, &incoming).is_err(),
            "noncanonical scope version {value}"
        );
    }
    let mut future = base.clone();
    future.scopes.get_mut("scope").unwrap().version = "2".into();
    assert!(
        prepare_snapshot(&base, &future).is_err(),
        "future scope version"
    );
    let mut wrong = base.clone();
    wrong.binding = "other".into();
    assert!(prepare_snapshot(&base, &wrong).is_err());
    let mut overflow = base.clone();
    overflow.revision = u64::MAX.to_string();
    assert!(prepare_snapshot(&overflow, &base).is_err());
}
