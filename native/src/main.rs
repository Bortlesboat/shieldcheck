mod contract;
mod no_sapling;
mod payment;
mod rpc;

use contract::{Failure, MAX_INPUT};
use serde_json::{Value, json};
use std::{io::Read, process::ExitCode, sync::mpsc, time::Duration};

fn failure(failure: Failure) -> (u8, Value) {
    match failure {
        Failure::Input => (2, json!({"status":"rejected","code":"invalid_input"})),
        Failure::Receipt => (2, json!({"status":"rejected","code":"invalid_receipt"})),
        Failure::Unavailable => (1, json!({"status":"error","code":"native_unavailable"})),
    }
}

fn read_input() -> contract::Result<Vec<u8>> {
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = std::io::stdin()
            .take(MAX_INPUT as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
            .map_err(|_| Failure::Input);
        let _ = send.send(result);
    });
    receive
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| Failure::Input)?
}

fn run(command: &str) -> contract::Result<Value> {
    let bytes = read_input()?;
    match command {
        "pay" => payment::pay(contract::parse_pay(&bytes)?),
        "verify" => Ok(
            json!({"status":"verified", "evidence": payment::verify(contract::parse_verify(&bytes)?)?}),
        ),
        _ => Err(Failure::Input),
    }
}

fn main() -> ExitCode {
    // Panic payloads may include upstream data. Only the fixed error reaches stdout.
    std::panic::set_hook(Box::new(|_| {}));
    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).map(String::as_str).unwrap_or("");
    if args.len() != 2 || !matches!(command, "pay" | "verify") {
        println!("{}", failure(Failure::Input).1);
        return ExitCode::from(2);
    }
    let deadline = if command == "pay" { 1200 } else { 30 };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(deadline));
        println!("{}", failure(Failure::Unavailable).1);
        std::process::exit(1);
    });
    let result = std::panic::catch_unwind(|| run(command)).unwrap_or(Err(Failure::Unavailable));
    let (code, output) = match result {
        Ok(output) => (0, output),
        Err(error) => failure(error),
    };
    println!("{output}");
    ExitCode::from(code)
}
