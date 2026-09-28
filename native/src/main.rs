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
    read_input_from(std::io::stdin(), Duration::from_secs(5))
}

fn read_input_from(
    input: impl Read + Send + 'static,
    timeout: Duration,
) -> contract::Result<Vec<u8>> {
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = input
            .take(MAX_INPUT as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
            .map_err(|_| Failure::Unavailable);
        let _ = send.send(result);
    });
    receive
        .recv_timeout(timeout)
        .map_err(|_| Failure::Unavailable)?
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};

    struct ErroringReader;

    impl Read for ErroringReader {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("test input failure"))
        }
    }

    struct StalledReader(mpsc::Receiver<()>);

    impl Read for StalledReader {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            self.0.recv().expect("test releases the reader");
            Ok(0)
        }
    }

    #[test]
    fn input_read_error_is_unavailable() {
        let error = read_input_from(ErroringReader, Duration::from_secs(1)).unwrap_err();
        assert_eq!(
            failure(error),
            (1, json!({"status":"error","code":"native_unavailable"}))
        );
    }

    #[test]
    fn input_timeout_is_unavailable() {
        let (release, wait) = mpsc::channel();
        let result = read_input_from(StalledReader(wait), Duration::from_millis(1));
        release.send(()).unwrap();
        assert_eq!(
            failure(result.unwrap_err()),
            (1, json!({"status":"error","code":"native_unavailable"}))
        );
    }

    #[test]
    fn completed_malformed_and_oversized_inputs_remain_rejected() {
        for input in [b"{}".to_vec(), vec![b' '; MAX_INPUT * 2]] {
            let expected_length = input.len().min(MAX_INPUT + 1);
            let bytes = read_input_from(Cursor::new(input), Duration::from_secs(1)).unwrap();
            assert_eq!(bytes.len(), expected_length);
            let error = contract::parse_pay(&bytes).err().expect("invalid input");
            assert_eq!(
                failure(error),
                (2, json!({"status":"rejected","code":"invalid_input"}))
            );
        }
    }
}
