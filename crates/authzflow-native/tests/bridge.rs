use authzflow_native::Bridge;
use serde_json::{Value, json};
fn call(bridge: &mut Bridge, value: Value) -> Value {
    serde_json::from_str(&bridge.call(&value.to_string())).unwrap()
}
#[test]
fn owned_runtime_requires_durable_ack_and_closes_handles() {
    let mut b = Bridge::default();
    let cp: Value = serde_json::from_str(include_str!("../../../fixtures/ready.json")).unwrap();
    let handle = call(&mut b, json!({"op":"create","checkpoint":cp}))["value"].clone();
    assert!(handle.is_string());
    let before = call(&mut b, json!({"op":"snapshot","handle":handle}));
    assert_eq!(before["value"]["phase"], "resync_required");
    let prepared = call(
        &mut b,
        json!({"op":"prepare_snapshot","handle":handle,"input":cp}),
    );
    assert_eq!(prepared["ok"], true);
    let stage = &prepared["value"];
    let ack = call(
        &mut b,
        json!({"op":"acknowledge","handle":handle,"transitionId":stage["transition_id"],"revision":stage["plan"]["next"]["revision"]}),
    );
    assert_eq!(ack["ok"], true);
    assert_eq!(
        call(&mut b, json!({"op":"snapshot","handle":handle}))["value"]["phase"],
        "ready"
    );
    assert_eq!(
        call(&mut b, json!({"op":"close","handle":handle}))["ok"],
        true
    );
    assert_eq!(
        call(&mut b, json!({"op":"snapshot","handle":handle}))["error"],
        "runtime_unavailable"
    );
}
#[test]
fn invalid_inputs_and_wrong_receipt_fail_closed() {
    let mut b = Bridge::default();
    assert_eq!(
        serde_json::from_str::<Value>(&b.call("not json")).unwrap(),
        json!({"ok":false,"error":"invalid_request"})
    );
    assert!(b.call(&"x".repeat(1_048_577)).contains("invalid_request"));
    assert_eq!(call(&mut b, json!({"op":"version"}))["value"], 2);
    assert_eq!(
        call(&mut b, json!({"op":"snapshot","handle":"forged"}))["error"],
        "runtime_unavailable"
    );
    let cp: Value = serde_json::from_str(include_str!("../../../fixtures/ready.json")).unwrap();
    let h = call(&mut b, json!({"op":"create","checkpoint":cp}))["value"].clone();
    let stage = call(
        &mut b,
        json!({"op":"prepare_snapshot","handle":h,"input":cp}),
    )["value"]
        .clone();
    assert_eq!(
        call(
            &mut b,
            json!({"op":"acknowledge","handle":h,"transitionId":stage["transition_id"],"revision":"wrong"})
        )["ok"],
        false
    );
    assert_eq!(
        call(&mut b, json!({"op":"snapshot","handle":h}))["value"]["phase"],
        "resync_required"
    );
}
