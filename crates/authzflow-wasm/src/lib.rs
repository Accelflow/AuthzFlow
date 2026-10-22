//! Thin ABI forwarding; authorization logic lives only in authzflow-core.
use wasm_bindgen::prelude::*;
#[wasm_bindgen]
pub fn dispatch(input: &str) -> Result<String, JsValue> {
    authzflow_core::dispatch(input).map_err(|error| JsValue::from_str(&error))
}

#[wasm_bindgen]
pub fn runtime_abi_version() -> u32 {
    2
}

#[wasm_bindgen]
pub struct WasmRuntime {
    inner: authzflow_core::OwnedRuntime,
}

#[wasm_bindgen]
impl WasmRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new(input: &str) -> Result<WasmRuntime, JsValue> {
        authzflow_core::OwnedRuntime::new(input)
            .map(|inner| Self { inner })
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn evaluate(
        &mut self,
        resource: &str,
        clock: &str,
        offline: bool,
    ) -> Result<String, JsValue> {
        self.inner
            .evaluate(resource, clock, offline)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn evaluate_many(
        &mut self,
        resources: &str,
        clock: &str,
        offline: bool,
    ) -> Result<String, JsValue> {
        self.inner
            .evaluate_many(resources, clock, offline)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn invalidated(
        &mut self,
        resources: &str,
        clock: &str,
        offline: bool,
    ) -> Result<String, JsValue> {
        self.inner
            .invalidated(resources, clock, offline)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn prepare_snapshot(&mut self, input: &str) -> Result<String, JsValue> {
        self.inner
            .prepare_snapshot(input)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn prepare_changes(&mut self, input: &str) -> Result<String, JsValue> {
        self.inner
            .prepare_changes(input)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn acknowledge(&mut self, id: &str, revision: &str) -> Result<(), JsValue> {
        self.inner
            .acknowledge(id, revision)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn fence(&mut self) {
        self.inner.fence();
    }
    pub fn close(&mut self) {
        self.inner.close();
    }
    pub fn snapshot(&self) -> Result<String, JsValue> {
        self.inner.snapshot().map_err(|e| JsValue::from_str(&e))
    }
    pub fn phase(&self) -> String {
        self.inner.phase()
    }
}
