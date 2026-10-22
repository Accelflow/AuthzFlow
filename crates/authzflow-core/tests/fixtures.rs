#[test]
fn shared_conformance_fixtures() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/conformance.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let actual = authzflow_core::dispatch(&case["request"].to_string());
        if let Some(error) = case.get("error") {
            assert_eq!(
                actual.unwrap_err(),
                error.as_str().unwrap(),
                "{}",
                case["name"]
            );
        } else {
            let actual: serde_json::Value = serde_json::from_str(&actual.unwrap()).unwrap();
            assert_eq!(actual, case["expected"], "{}", case["name"]);
        }
    }
}
