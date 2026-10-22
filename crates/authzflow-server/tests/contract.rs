use authzflow_server::*;
use serde_json::{Value, json};
use std::{
    future::Future,
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
};

struct WakeThread(std::thread::Thread);
impl Wake for WakeThread {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}
fn block_on<T>(future: impl Future<Output = T>) -> T {
    let waker = Waker::from(Arc::new(WakeThread(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::park(),
        }
    }
}
struct Host(Value);
impl AuthorizationAdapter for Host {
    type Context = ();
    type Principal = ();
    type Target = ();
    async fn authenticate(&self, _: &()) -> Result<Option<Identity<()>>, AdapterError> {
        if self.0["hostError"] == true {
            return Err(AdapterError);
        }
        if self.0["authenticated"] == false {
            return Ok(None);
        }
        Ok(Some(Identity {
            binding: self.0["binding"].as_str().unwrap().into(),
            principal: (),
        }))
    }
    async fn authorize(
        &self,
        _: &(),
        _: &(),
        _: &(),
    ) -> Result<AuthorizationDecision, AdapterError> {
        Ok(match self.0["decision"].as_str() {
            Some("forbidden") => AuthorizationDecision::Forbidden,
            Some("not_found") => AuthorizationDecision::NotFound,
            _ => AuthorizationDecision::Allow(
                serde_json::from_value(self.0["metadata"].clone()).unwrap(),
            ),
        })
    }
}

#[test]
fn shared_wire_contract() {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("../../../fixtures/server/checks.json")).unwrap();
    for fixture in fixtures {
        let policy = serde_json::from_value(
            fixture
                .get("policy")
                .cloned()
                .unwrap_or(json!({"mode":"online_only"})),
        )
        .unwrap();
        let provider = CheckProvider::new(policy, 5000).unwrap();
        let result = block_on(provider.check(&Host(fixture.clone()), &fixture["query"], &(), &()));
        let mut actual = serde_json::to_value(result).unwrap();
        assert_eq!(actual["headers"], json!({"Cache-Control":"no-store"}));
        actual.as_object_mut().unwrap().remove("headers");
        if actual["status"] == 200 {
            let epoch = actual["body"]
                .as_object_mut()
                .unwrap()
                .remove("epoch")
                .unwrap();
            assert_eq!(epoch.as_str().unwrap().len(), 36);
        }
        assert_eq!(actual, fixture["expected"], "{}", fixture["name"]);
    }
}

#[test]
fn policy_bounds_and_fresh_epochs() {
    for ttl_minutes in [0., -1., 1441., f64::NAN, f64::INFINITY] {
        assert!(CheckProvider::new(ReadPolicy::OfflineTtl { ttl_minutes }, 5000).is_err());
    }
    for lease in [0, 5001] {
        assert!(CheckProvider::new(ReadPolicy::OnlineOnly, lease).is_err());
    }
    let host = Host(
        json!({"binding":"user","metadata":{"scopeId":"s","resourceId":"r","contentHash":"a".repeat(64)}}),
    );
    let provider = CheckProvider::new(ReadPolicy::OnlineOnly, 5000).unwrap();
    let query = json!({"requestId":"nonce"});
    fn assert_send(_: impl Send) {}
    assert_send(provider.check(&host, &query, &(), &()));
    let first = block_on(provider.check(&host, &query, &(), &()));
    let second = block_on(provider.check(&host, &query, &(), &()));
    assert_ne!(first.body["epoch"], second.body["epoch"]);
}
