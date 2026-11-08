use authzflow_core::dispatch_group;
use serde_json::{Value, json};

fn run(value: Value) -> Value {
    serde_json::from_str(&dispatch_group(&value.to_string()).unwrap()).unwrap()
}

#[test]
fn group_revoke_fences_two_resources_and_revalidate_never_grants() {
    let f: Value = serde_json::from_str(include_str!(
        "../../../contracts/resource-group/v2/fixtures.json"
    ))
    .unwrap();
    let mut s = run(json!({"op":"initialize","identity":f["identity"],"position":f["position"]}));
    for id in f["resources"].as_array().unwrap() {
        s = run(json!({"op":"register","state":s,"resourceId":id}));
        s = run(
            json!({"op":"grant","state":s,"resourceId":id,"anchor":{"resourceGroupId":"group-a","epoch":"epoch-a","sequence":"0"}}),
        );
    }
    assert_eq!(
        run(json!({"op":"guard","state":s,"resourceId":"article-a","generation":"0"})),
        true
    );
    let next = run(json!({"op":"changes","state":s,"batch":f["batch"]}));
    for id in f["resources"].as_array().unwrap() {
        assert_eq!(
            run(json!({"op":"guard","state":next,"resourceId":id,"generation":"0"})),
            false
        );
        assert_eq!(next["resources"][id.as_str().unwrap()]["intent"], "revoke");
    }
    assert_eq!(next["sequence"], "2");
    assert!(dispatch_group(&json!({"op":"grant","state":next,"resourceId":"article-a","anchor":{"resourceGroupId":"group-a","epoch":"epoch-a","sequence":"0"}}).to_string()).is_err());
}

#[test]
fn group_rejects_gaps_wrong_binding_unknown_fields_and_overflow() {
    let f: Value = serde_json::from_str(include_str!(
        "../../../contracts/resource-group/v2/fixtures.json"
    ))
    .unwrap();
    let s = run(json!({"op":"initialize","identity":f["identity"],"position":f["position"]}));
    for (field, value) in [
        ("binding", json!("other")),
        ("resourceGroupId", json!("other")),
        ("throughSequence", json!("18446744073709551616")),
        ("extra", json!(true)),
    ] {
        let mut batch = f["batch"].clone();
        batch[field] = value;
        assert!(
            dispatch_group(&json!({"op":"changes","state":s,"batch":batch}).to_string()).is_err()
        );
    }
    let mut batch = f["batch"].clone();
    batch["changes"][0]["sequence"] = json!("2");
    assert!(dispatch_group(&json!({"op":"changes","state":s,"batch":batch}).to_string()).is_err());
}
