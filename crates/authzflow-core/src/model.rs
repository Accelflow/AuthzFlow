use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Clock {
    pub boot: String,
    pub now_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Uninitialized,
    Ready,
    CommitPending,
    ResyncRequired,
    Closed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Allow,
    Deny,
    Revalidate,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub access: Access,
    pub version: String,
    pub expires_at_ms: u64,
    pub offline: bool,
    pub boot: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub schema_version: u32,
    pub binding: String,
    pub epoch: String,
    pub sequence: String,
    pub revision: String,
    pub cursor: String,
    pub phase: Phase,
    #[serde(default)]
    pub resources: BTreeMap<String, Entry>,
    #[serde(default)]
    pub scopes: BTreeMap<String, Entry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub allowed: bool,
    pub reason: String,
}
