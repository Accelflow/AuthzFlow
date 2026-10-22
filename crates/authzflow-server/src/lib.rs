use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, future::Future};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ReadPolicy {
    OnlineOnly,
    OfflineTtl {
        #[serde(rename = "ttlMinutes")]
        ttl_minutes: f64,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckMetadata {
    pub scope_id: String,
    pub resource_id: String,
    pub content_hash: String,
}
pub struct Identity<P> {
    pub binding: String,
    pub principal: P,
}
pub enum AuthorizationDecision {
    Allow(CheckMetadata),
    Forbidden,
    NotFound,
}
#[derive(Debug)]
pub struct AdapterError;

/// Host authentication and authorization remain authoritative; implementations must not trust client identity fields.
pub trait AuthorizationAdapter: Sync {
    type Context: Sync;
    type Principal: Send + Sync;
    type Target: Sync;
    fn authenticate(
        &self,
        context: &Self::Context,
    ) -> impl Future<Output = Result<Option<Identity<Self::Principal>>, AdapterError>> + Send;
    fn authorize(
        &self,
        context: &Self::Context,
        principal: &Self::Principal,
        target: &Self::Target,
    ) -> impl Future<Output = Result<AuthorizationDecision, AdapterError>> + Send;
}

#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub status: u16,
    pub headers: BTreeMap<&'static str, &'static str>,
    pub body: Value,
}
#[derive(Debug, PartialEq)]
pub struct ConfigError;
impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("authz_server_config_invalid")
    }
}
impl std::error::Error for ConfigError {}

pub struct CheckProvider {
    max_offline_ms: u64,
    lease_ms: u32,
}
impl CheckProvider {
    pub fn new(policy: ReadPolicy, lease_ms: u32) -> Result<Self, ConfigError> {
        let milliseconds = match policy {
            ReadPolicy::OnlineOnly => 0.,
            ReadPolicy::OfflineTtl { ttl_minutes } => {
                let value = ttl_minutes * 60_000.;
                if !value.is_finite() || value <= 0. || value > 86_400_000. || value.fract() != 0. {
                    return Err(ConfigError);
                }
                value
            }
        };
        if !(1..=5000).contains(&lease_ms) {
            return Err(ConfigError);
        }
        Ok(Self {
            max_offline_ms: milliseconds as u64,
            lease_ms,
        })
    }
    pub async fn check<A: AuthorizationAdapter>(
        &self,
        adapter: &A,
        query: &Value,
        context: &A::Context,
        target: &A::Target,
    ) -> CheckResult {
        let headers = BTreeMap::from([("Cache-Control", "no-store")]);
        let fail = |status, code| CheckResult {
            status,
            headers: headers.clone(),
            body: serde_json::json!({"error":{"code":code}}),
        };
        let Some(request_id) = query.get("requestId").and_then(Value::as_str) else {
            return fail(400, "invalid_authz_check");
        };
        if query.as_object().is_none_or(|q| q.len() != 1)
            || request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return fail(400, "invalid_authz_check");
        }
        let identity = match adapter.authenticate(context).await {
            Ok(Some(identity)) => identity,
            Ok(None) => return fail(401, "user_session_required"),
            Err(_) => return fail(503, "authz_check_unavailable"),
        };
        if identity.binding.is_empty() || identity.binding.encode_utf16().count() > 4096 {
            return fail(503, "authz_check_unavailable");
        }
        let metadata = match adapter
            .authorize(context, &identity.principal, target)
            .await
        {
            Ok(AuthorizationDecision::Allow(metadata)) => metadata,
            Ok(AuthorizationDecision::Forbidden) => return fail(403, "access_required"),
            Ok(AuthorizationDecision::NotFound) => return fail(404, "resource_not_found"),
            Err(_) => return fail(503, "authz_check_unavailable"),
        };
        if metadata.scope_id.is_empty()
            || metadata.scope_id.encode_utf16().count() > 4096
            || metadata.resource_id.is_empty()
            || metadata.resource_id.encode_utf16().count() > 4096
            || metadata.content_hash.len() != 64
            || !metadata
                .content_hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return fail(503, "authz_check_unavailable");
        }
        CheckResult {
            status: 200,
            headers,
            body: serde_json::json!({
                "schemaVersion":1,"mode":"check_only","requestId":request_id,"binding":identity.binding,
                "epoch":uuid::Uuid::new_v4().to_string(),"scopeId":metadata.scope_id,"resourceId":metadata.resource_id,
                "contentHash":metadata.content_hash,"leaseMs":self.lease_ms,
                "readPolicy":{"mode":if self.max_offline_ms == 0 {"online_only"} else {"offline_ttl"},"maxOfflineMs":self.max_offline_ms}
            }),
        }
    }
}
