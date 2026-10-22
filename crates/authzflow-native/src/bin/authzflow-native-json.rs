use std::io::{self, BufRead};
fn main() {
    let mut bridge = authzflow_native::Bridge::default();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        println!("{}", bridge.call(&line));
    }
}
