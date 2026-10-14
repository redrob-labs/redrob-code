//! Live check against a real daemon: require it, print the base and the headers an app would send.
//! Run with `REDROB_CODE_BIN=<redrob 0.6.2> REDROB_RUN_DIR=<scratch> cargo run --example live`.
fn main() {
    let record = match redrob_engine_client::require_as("shape", 1) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("unavailable: {e}");
            std::process::exit(2);
        }
    };
    println!("base={}", redrob_engine_client::openai_base(&record));
    println!("pid={} version={}", record.pid, record.version);
    for (k, v) in redrob_engine_client::app_headers(&record, "shape", Some("doc-1")) {
        println!("{k}: {}", if k == "Authorization" { "Basic …".to_string() } else { v });
    }
    let clients = redrob_engine_client::clients(&record).expect("clients");
    println!("attached={}", clients.clients.len());
}
