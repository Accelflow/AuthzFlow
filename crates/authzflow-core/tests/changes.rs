use authzflow_core::{Access, Checkpoint, dispatch, prepare_snapshot};
use serde_json::json;
fn base() -> Checkpoint {
    serde_json::from_str(include_str!("../../../fixtures/ready.json")).unwrap()
}
fn request() -> serde_json::Value {
    json!({"op":"changes","state":base(),"batch":{"binding":"actor","epoch":"epoch","from_sequence":"1","through_sequence":"2","next_cursor":"cursor-2","changes":[{"sequence":"2","target":{"kind":"scope","id":"scope"},"action":"revoke"}]}})
}
#[test]
fn changes_are_ordered_and_cursor_is_committed_with_denial() {
    let req = request();
    let plan: serde_json::Value =
        serde_json::from_str(&dispatch(&req.to_string()).expect("CHANGES_MISSING")).unwrap();
    assert_eq!(plan["pending"]["cursor"], "cursor-1");
    assert_eq!(plan["pending"]["phase"], "commit_pending");
    assert_eq!(plan["next"]["cursor"], "cursor-2");
    assert_eq!(plan["next"]["scopes"]["scope"]["access"], "deny");
    for (field, value) in [
        ("from_sequence", "0"),
        ("epoch", "other"),
        ("binding", "other"),
        ("through_sequence", "01"),
    ] {
        let mut req = request();
        req["batch"][field] = json!(value);
        assert!(dispatch(&req.to_string()).is_err(), "reject {field}");
    }
    let mut duplicate = request();
    let event = duplicate["batch"]["changes"][0].clone();
    duplicate["batch"]["changes"]
        .as_array_mut()
        .unwrap()
        .push(event);
    assert!(dispatch(&duplicate.to_string()).is_err());
}
#[test]
fn authoritative_check_can_resolve_revalidation_at_same_version() {
    let mut state = base();
    state.resources.get_mut("article").unwrap().access = Access::Revalidate;
    assert!(
        prepare_snapshot(&state, &base()).is_ok(),
        "REVALIDATE_CHECK_MISSING"
    );
}
