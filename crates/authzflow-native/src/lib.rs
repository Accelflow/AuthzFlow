//! Native transport only. Every authorization decision/transition is OwnedRuntime.
use authzflow_core::OwnedRuntime;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ffi::{CString, c_char},
    sync::{Mutex, OnceLock},
};
const MAX_INPUT: usize = 1_048_576;
#[derive(Default)]
pub struct Bridge {
    next: u64,
    runtimes: HashMap<String, OwnedRuntime>,
}
impl Bridge {
    pub fn call(&mut self, input: &str) -> String {
        let result = if input.len() > MAX_INPUT {
            Err("invalid_request".to_string())
        } else {
            serde_json::from_str::<Value>(input)
                .map_err(|_| "invalid_request".to_string())
                .and_then(|value| self.request(value))
        };
        match result {
            Ok(value) => json!({"ok":true,"value":value}).to_string(),
            Err(error) => json!({"ok":false,"error":error}).to_string(),
        }
    }
    fn request(&mut self, v: Value) -> Result<Value, String> {
        let op = v["op"].as_str().ok_or("invalid_request")?;
        if op == "version" {
            return Ok(json!(2));
        }
        if op == "create" {
            if self.runtimes.len() >= 1024 {
                return Err("runtime_capacity".into());
            }
            let runtime = OwnedRuntime::new(&v["checkpoint"].to_string())?;
            self.next = self.next.checked_add(1).ok_or("runtime_capacity")?;
            let handle = self.next.to_string();
            self.runtimes.insert(handle.clone(), runtime);
            return Ok(json!(handle));
        }
        let handle = v["handle"].as_str().ok_or("runtime_unavailable")?;
        if op == "close" {
            let mut r = self.runtimes.remove(handle).ok_or("runtime_unavailable")?;
            r.close();
            return serde_json::from_str(&r.snapshot()?).map_err(|_| "invalid_response".into());
        }
        let r = self.runtimes.get_mut(handle).ok_or("runtime_unavailable")?;
        let text = |key: &str| v[key].as_str().ok_or_else(|| "invalid_request".to_string());
        let decoded = |result: Result<String, String>| {
            result.and_then(|text| {
                serde_json::from_str(&text).map_err(|_| "invalid_response".to_string())
            })
        };
        match op {
            "evaluate" => decoded(r.evaluate(
                text("resource")?,
                &v["clock"].to_string(),
                v["offline"].as_bool().ok_or("invalid_request")?,
            )),
            "invalidated" => decoded(r.invalidated(
                &v["resources"].to_string(),
                &v["clock"].to_string(),
                v["offline"].as_bool().ok_or("invalid_request")?,
            )),
            "prepare_snapshot" => decoded(r.prepare_snapshot(&v["input"].to_string())),
            "prepare_changes" => decoded(r.prepare_changes(&v["input"].to_string())),
            "acknowledge" => {
                r.acknowledge(text("transitionId")?, text("revision")?)?;
                Ok(Value::Null)
            }
            "snapshot" => decoded(r.snapshot()),
            "phase" => Ok(json!(r.phase())),
            "fence" => {
                r.fence();
                Ok(Value::Null)
            }
            _ => Err("invalid_request".into()),
        }
    }
}
static BRIDGE: OnceLock<Mutex<Bridge>> = OnceLock::new();
/// # Safety
/// `input` must point to `length` readable bytes for this call, or be null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn authzflow_native_call(input: *const u8, length: usize) -> *mut c_char {
    let result = std::panic::catch_unwind(|| {
        if input.is_null() || length > MAX_INPUT {
            return json!({"ok":false,"error":"invalid_request"}).to_string();
        }
        // SAFETY: the platform caller owns the UTF-8 buffer for this synchronous call.
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let Ok(text) = std::str::from_utf8(bytes) else {
            return json!({"ok":false,"error":"invalid_request"}).to_string();
        };
        match BRIDGE.get_or_init(|| Mutex::new(Bridge::default())).lock() {
            Ok(mut b) => b.call(text),
            Err(_) => json!({"ok":false,"error":"runtime_unavailable"}).to_string(),
        }
    })
    .unwrap_or_else(|_| json!({"ok":false,"error":"runtime_unavailable"}).to_string());
    CString::new(result).expect("JSON escapes NUL").into_raw()
}
/// # Safety
/// `output` is null or a live pointer returned by authzflow_native_call, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn authzflow_native_free(output: *mut c_char) {
    if !output.is_null() {
        // SAFETY: ownership is returned by the platform caller exactly once.
        drop(unsafe { CString::from_raw(output) });
    }
}
