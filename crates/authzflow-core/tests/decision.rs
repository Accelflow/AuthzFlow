// Regression tests for the pure read boundary.
use authzflow_core::{Access, Checkpoint, Clock, Entry, Phase, evaluate};
use std::collections::BTreeMap;

fn ready() -> Checkpoint {
    let entry = Entry {
        access: Access::Allow,
        version: "1".into(),
        expires_at_ms: 100,
        offline: true,
        boot: "boot".into(),
        scopes: vec![],
        stale: false,
    };
    let mut resource = entry.clone();
    resource.scopes = vec!["scope".into()];
    Checkpoint {
        schema_version: 1,
        binding: "actor".into(),
        epoch: "epoch".into(),
        sequence: "1".into(),
        revision: "1".into(),
        cursor: "cursor".into(),
        phase: Phase::Ready,
        resources: BTreeMap::from([("article".into(), resource)]),
        scopes: BTreeMap::from([("scope".into(), entry)]),
    }
}

#[test]
fn read_boundary_conformance() {
    let state = ready();
    let clock = Clock {
        boot: "boot".into(),
        now_ms: 50,
    };
    assert!(
        evaluate(&state, "article", &clock, false).allowed,
        "READ_BOUNDARY_VALID_ALLOW"
    );
    assert!(!evaluate(&state, "unknown", &clock, false).allowed);
    for now_ms in [100, 101] {
        assert!(
            !evaluate(
                &state,
                "article",
                &Clock {
                    now_ms,
                    ..clock.clone()
                },
                false
            )
            .allowed
        );
    }
    for phase in [
        Phase::Uninitialized,
        Phase::CommitPending,
        Phase::ResyncRequired,
        Phase::Closed,
    ] {
        let mut s = state.clone();
        s.phase = phase;
        assert!(!evaluate(&s, "article", &clock, false).allowed);
    }
    for access in [Access::Deny, Access::Revalidate] {
        let mut s = state.clone();
        s.resources.get_mut("article").unwrap().access = access.clone();
        assert!(!evaluate(&s, "article", &clock, false).allowed);
        let mut s = state.clone();
        s.scopes.get_mut("scope").unwrap().access = access;
        assert!(!evaluate(&s, "article", &clock, false).allowed);
    }
    let mut s = state.clone();
    s.scopes.clear();
    assert!(!evaluate(&s, "article", &clock, false).allowed);
    let mut s = state.clone();
    s.resources.get_mut("article").unwrap().stale = true;
    assert!(!evaluate(&s, "article", &clock, false).allowed);
    assert!(
        !evaluate(
            &state,
            "article",
            &Clock {
                boot: "other".into(),
                ..clock.clone()
            },
            false
        )
        .allowed
    );
    for scope in [false, true] {
        let mut s = state.clone();
        if scope {
            s.scopes.get_mut("scope").unwrap().offline = false;
        } else {
            s.resources.get_mut("article").unwrap().offline = false;
        }
        assert!(!evaluate(&s, "article", &clock, true).allowed);
        assert!(evaluate(&s, "article", &clock, false).allowed);
    }
    let mut s = state.clone();
    s.schema_version = 2;
    assert!(!evaluate(&s, "article", &clock, false).allowed);
}
