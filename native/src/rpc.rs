use std::{io::Read, time::Duration};

use reqwest::blocking::Client;
use serde_json::{Value, json};

use crate::contract::{BRANCH, Failure, GENESIS, Result, lower_hex};

const MAX_RESPONSE: u64 = 8 * 1024 * 1024;

fn validate_context(
    info: &Value,
    genesis: &Value,
    peers: &Value,
    network: &Value,
    fresh: bool,
) -> Result<u32> {
    let height = info
        .get("blocks")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(Failure::Unavailable)?;
    // At genesis only chaintip remains Sprout; the next block is NU6.3.
    // Zebra reports "test" for regtest. The exact genesis, not this label, pins
    // the chain identity; a public testnet node cannot satisfy this predicate.
    if !matches!(
        info.get("chain").and_then(Value::as_str),
        Some("test" | "regtest")
    ) || genesis.as_str() != Some(GENESIS)
        || peers.as_array().is_none_or(|p| !p.is_empty())
        || network.get("connections").and_then(Value::as_u64) != Some(0)
        || network.get("testnet").and_then(Value::as_bool) != Some(true)
        || info.pointer("/consensus/nextblock").and_then(Value::as_str) != Some(BRANCH)
        || (height > 0
            && info.pointer("/consensus/chaintip").and_then(Value::as_str) != Some(BRANCH))
        || (fresh && height != 0)
    {
        return Err(Failure::Unavailable);
    }
    Ok(height)
}

/// The fixture accepts only a port, so user input can never select another host.
pub struct Rpc {
    client: Client,
    endpoint: String,
}

impl Rpc {
    pub fn new(port: u16) -> Result<Self> {
        if port == 0 {
            return Err(Failure::Input);
        }
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(90))
                .build()
                .map_err(|_| Failure::Unavailable)?,
            endpoint: format!("http://127.0.0.1:{port}"),
        })
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_inner(method, params, false)
    }

    pub fn receipt_transaction(&self, txid: &str) -> Result<Value> {
        self.call_inner("getrawtransaction", json!([txid, 1]), true)
    }

    fn call_inner(&self, method: &str, params: Value, missing_is_rejection: bool) -> Result<Value> {
        let response = self
            .client
            .post(&self.endpoint)
            .json(&json!({"jsonrpc":"2.0", "id":1, "method":method, "params":params}))
            .send()
            .map_err(|_| Failure::Unavailable)?;
        let status = response.status();
        if (!status.is_success() && status.as_u16() != 500)
            || response.content_length().is_some_and(|n| n > MAX_RESPONSE)
        {
            return Err(Failure::Unavailable);
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Failure::Unavailable)?;
        if bytes.len() as u64 > MAX_RESPONSE {
            return Err(Failure::Unavailable);
        }
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::Unavailable)?;
        if body.get("id") != Some(&json!(1)) {
            return Err(Failure::Unavailable);
        }
        if let Some(error) = body.get("error").filter(|e| !e.is_null()) {
            // Zcash's documented invalid-address-or-key code is used for a missing tx.
            // No other RPC, server or transport error is a security-test rejection.
            return Err(
                if missing_is_rejection
                    && body.get("result").is_none_or(Value::is_null)
                    && error.get("code").and_then(Value::as_i64) == Some(-5)
                {
                    Failure::Receipt
                } else {
                    Failure::Unavailable
                },
            );
        }
        if !status.is_success() {
            return Err(Failure::Unavailable);
        }
        body.get("result").cloned().ok_or(Failure::Unavailable)
    }

    pub fn isolated_height(&self, fresh: bool) -> Result<u32> {
        let info = self.call("getblockchaininfo", json!([]))?;
        let genesis = self.call("getblockhash", json!([0]))?;
        let peers = self.call("getpeerinfo", json!([]))?;
        let network = self.call("getinfo", json!([]))?;
        validate_context(&info, &genesis, &peers, &network, fresh)
    }

    pub fn mine(&self, count: u32, address: &str) -> Result<Vec<String>> {
        let value = self.call("generatetoaddress", json!([count, address]))?;
        let values = value.as_array().ok_or(Failure::Unavailable)?;
        if values.len() != count as usize {
            return Err(Failure::Unavailable);
        }
        values
            .iter()
            .map(|v| {
                let hash = v.as_str().ok_or(Failure::Unavailable)?;
                if !lower_hex(hash, 32) {
                    return Err(Failure::Unavailable);
                }
                Ok(hash.to_owned())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener};

    #[test]
    fn observed_zebra_regtest_context_requires_exact_identity_and_isolation() {
        // Zebra 6.4.2 actually returns chain="test" for its isolated regtest node.
        let info = json!({"chain":"test", "blocks":0,
            "consensus":{"chaintip":"00000000", "nextblock":BRANCH}});
        let network = json!({"version":6040200, "build":"v6.4.2", "blocks":0,
            "connections":0, "testnet":true});
        assert_eq!(
            validate_context(&info, &json!(GENESIS), &json!([]), &network, true),
            Ok(0)
        );
        assert_eq!(
            validate_context(&info, &json!("00".repeat(32)), &json!([]), &network, true),
            Err(Failure::Unavailable)
        );
        assert_eq!(
            validate_context(&info, &json!(GENESIS), &json!([{}]), &network, true),
            Err(Failure::Unavailable)
        );
        let mut connected = network.clone();
        connected["connections"] = json!(1);
        assert_eq!(
            validate_context(&info, &json!(GENESIS), &json!([]), &connected, true),
            Err(Failure::Unavailable)
        );
        let mut wrong_branch = info.clone();
        wrong_branch["consensus"]["nextblock"] = json!("5437f330");
        assert_eq!(
            validate_context(&wrong_branch, &json!(GENESIS), &json!([]), &network, true),
            Err(Failure::Unavailable)
        );
        let mut used = info.clone();
        used["blocks"] = json!(1);
        used["consensus"]["chaintip"] = json!(BRANCH);
        assert_eq!(
            validate_context(&used, &json!(GENESIS), &json!([]), &network, true),
            Err(Failure::Unavailable)
        );
        assert_eq!(
            validate_context(&used, &json!(GENESIS), &json!([]), &network, false),
            Ok(1)
        );
    }

    fn serve(status: &str, body: &str, extra_headers: &str) -> Rpc {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n{extra_headers}\r\n{body}",
            body.len()
        );
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            stream.write_all(response.as_bytes()).unwrap();
        });
        Rpc::new(port).unwrap()
    }

    #[test]
    fn only_documented_missing_transaction_code_is_a_rejection() {
        let missing = r#"{"id":1,"result":null,"error":{"code":-5,"message":"not found"}}"#;
        for status in ["200 OK", "500 Internal Server Error"] {
            assert_eq!(
                serve(status, missing, "").receipt_transaction(&"00".repeat(32)),
                Err(Failure::Receipt)
            );
        }
        assert_eq!(
            serve("200 OK", missing, "").call("getblock", json!([])),
            Err(Failure::Unavailable)
        );
        let internal = r#"{"id":1,"result":null,"error":{"code":-32603,"message":"private data"}}"#;
        assert_eq!(
            serve("200 OK", internal, "").receipt_transaction(&"00".repeat(32)),
            Err(Failure::Unavailable)
        );
        assert_eq!(
            serve("503 Service Unavailable", missing, "").receipt_transaction(&"00".repeat(32)),
            Err(Failure::Unavailable)
        );
    }

    #[test]
    fn malformed_mismatched_and_redirected_rpc_are_unavailable() {
        for body in ["not json", r#"{"id":2,"result":0}"#, r#"{"id":1}"#] {
            assert_eq!(
                serve("200 OK", body, "").call("getblockcount", json!([])),
                Err(Failure::Unavailable)
            );
        }
        assert_eq!(
            serve("302 Found", "", "Location: http://127.0.0.1:1\r\n")
                .call("getblockcount", json!([])),
            Err(Failure::Unavailable)
        );
    }
}
