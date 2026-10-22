// JSON ABI regression anchor.

#[test]
fn owned_runtime_matches_pure_decisions_and_fences_native_clock_and_changes() {
    use authzflow_core::{Checkpoint, Clock, Decision, OwnedRuntime};
    let input = include_str!("../../../fixtures/ready.json");
    for offline in [false, true] {
        for now in [50, 100] {
            let mut runtime = OwnedRuntime::new(input).unwrap();
            let prepared: serde_json::Value =
                serde_json::from_str(&runtime.prepare_snapshot(input).unwrap()).unwrap();
            assert_eq!(runtime.phase(), "commit_pending");
            runtime
                .acknowledge(
                    prepared["transition_id"].as_str().unwrap(),
                    prepared["plan"]["next"]["revision"].as_str().unwrap(),
                )
                .unwrap();
            let state: Checkpoint =
                serde_json::from_value(prepared["plan"]["next"].clone()).unwrap();
            let clock = Clock {
                boot: "boot".into(),
                now_ms: now,
            };
            let decisions: Vec<Decision> = serde_json::from_str(
                &runtime
                    .evaluate_many(
                        "[\"article\",\"missing\"]",
                        &serde_json::to_string(&clock).unwrap(),
                        offline,
                    )
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                decisions,
                vec![
                    authzflow_core::evaluate(&state, "article", &clock, offline),
                    authzflow_core::evaluate(&state, "missing", &clock, offline)
                ]
            );
        }
    }
    let mut runtime = OwnedRuntime::new(input).unwrap();
    let p: serde_json::Value =
        serde_json::from_str(&runtime.prepare_snapshot(input).unwrap()).unwrap();
    runtime
        .acknowledge(p["transition_id"].as_str().unwrap(), "2")
        .unwrap();
    let batch = serde_json::json!({"binding":"actor","epoch":"epoch","from_sequence":"1","through_sequence":"2","next_cursor":"cursor-2","changes":[{"sequence":"2","target":{"kind":"scope","id":"scope"},"action":"revoke"}]});
    let p: serde_json::Value =
        serde_json::from_str(&runtime.prepare_changes(&batch.to_string()).unwrap()).unwrap();
    assert_eq!(
        runtime
            .invalidated("[\"article\"]", "{\"boot\":\"boot\",\"now_ms\":50}", false)
            .unwrap(),
        "[\"article\"]"
    );
    let denied: Decision = serde_json::from_str(
        &runtime
            .evaluate("article", "{\"boot\":\"boot\",\"now_ms\":50}", false)
            .unwrap(),
    )
    .unwrap();
    assert!(!denied.allowed);
    runtime
        .acknowledge(p["transition_id"].as_str().unwrap(), "3")
        .unwrap();
    assert_eq!(
        runtime
            .evaluate("article", "{\"boot\":\"other-boot\",\"now_ms\":50}", false)
            .unwrap_err(),
        "clock_discontinuity"
    );
    assert_eq!(runtime.phase(), "resync_required");
    assert_eq!(
        OwnedRuntime::new(&" ".repeat(1048577)).err().unwrap(),
        "invalid_request"
    );
    let mut malformed = OwnedRuntime::new(input).unwrap();
    assert!(malformed.prepare_snapshot("{}").is_err());
    assert_eq!(malformed.phase(), "resync_required");
}

#[test]
fn json_abi_many_preserves_order_and_bounds() {
    let state: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/ready.json")).unwrap();
    let mut request = serde_json::json!({"op":"evaluate_many","state":state,"resources":["article","missing","article"],"clock":{"boot":"boot","now_ms":50},"offline":false});
    let result = authzflow_core::dispatch(&request.to_string()).expect("BATCH_EVALUATION_MISSING");
    let decisions: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(decisions[0]["allowed"], true);
    assert_eq!(decisions[1]["allowed"], false);
    assert_eq!(decisions[2]["allowed"], true);
    request["resources"] = serde_json::json!([]);
    assert_eq!(
        authzflow_core::dispatch(&request.to_string()).unwrap(),
        "[]"
    );
    request["resources"] = serde_json::json!(vec!["article"; 1025]);
    assert!(authzflow_core::dispatch(&request.to_string()).is_err());
}

#[test]
fn json_abi_read() {
    let state: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/ready.json")).unwrap();
    let request = serde_json::json!({
        "op": "evaluate",
        "state": state,
        "resource": "article",
        "clock": {"boot": "boot", "now_ms": 50},
        "offline": false
    });
    let output = authzflow_core::dispatch(&request.to_string()).expect("ABI_MISSING");
    let result: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(result["allowed"], true);
    assert!(authzflow_core::dispatch("{}").is_err());
}
