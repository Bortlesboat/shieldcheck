use serde::{Deserialize, Serialize};

pub const GENESIS: &str = "029f11d80ef9765602235e1bc9727e3eb6ba20839319f761fee920d63401e327";
pub const BRANCH: &str = "37a5165b";
pub const MAX_INPUT: usize = 8192;
pub const MAX_AMOUNT: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Input,
    Receipt,
    Unavailable,
}

pub type Result<T> = std::result::Result<T, Failure>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PayInput {
    pub rpc_port: u16,
    pub memo: String,
    pub amount_zat: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub schema: String,
    pub network: String,
    pub pool: String,
    pub txid: String,
    pub action_index: usize,
    pub ock: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expected {
    pub recipient: String,
    pub amount_zat: u64,
    pub memo: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyInput {
    pub rpc_port: u16,
    pub receipt: Receipt,
    pub expected: Expected,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub network: &'static str,
    pub pool: &'static str,
    pub genesis: &'static str,
    pub branch_id: &'static str,
    pub txid: String,
    pub block_hash: String,
    pub block_height: u32,
    pub confirmations: u32,
    pub shielded_only: bool,
}

fn parse<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T> {
    if bytes.len() > MAX_INPUT {
        return Err(Failure::Input);
    }
    serde_json::from_slice(bytes).map_err(|_| Failure::Input)
}

pub fn lower_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn invoice_is_valid(port: u16, amount: u64, memo: &str) -> bool {
    port != 0 && (1..=MAX_AMOUNT).contains(&amount) && (1..=512).contains(&memo.len())
}

pub fn parse_pay(bytes: &[u8]) -> Result<PayInput> {
    let input: PayInput = parse(bytes)?;
    if !invoice_is_valid(input.rpc_port, input.amount_zat, &input.memo) {
        return Err(Failure::Input);
    }
    Ok(input)
}

pub fn parse_verify(bytes: &[u8]) -> Result<VerifyInput> {
    let input: VerifyInput = parse(bytes)?;
    if !invoice_is_valid(
        input.rpc_port,
        input.expected.amount_zat,
        &input.expected.memo,
    ) || !lower_hex(&input.expected.recipient, 43)
    {
        return Err(Failure::Input);
    }
    let receipt = &input.receipt;
    if receipt.schema != "shieldcheck-receipt/v1"
        || receipt.network != "regtest"
        || receipt.pool != "ironwood"
        || !lower_hex(&receipt.txid, 32)
        || !lower_hex(&receipt.ock, 32)
    {
        return Err(Failure::Receipt);
    }
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> serde_json::Value {
        json!({"rpcPort": 12345, "receipt": {"schema": "shieldcheck-receipt/v1",
            "network": "regtest", "pool": "ironwood", "txid": "ab".repeat(32),
            "actionIndex": 0, "ock": "cd".repeat(32)},
            "expected": {"recipient": "ef".repeat(43), "amountZat": 100000,
            "memo": "synthetic memo"}})
    }

    fn decode(value: &serde_json::Value) -> Result<VerifyInput> {
        parse_verify(&serde_json::to_vec(value).unwrap())
    }

    #[test]
    fn valid_contract_decodes() {
        assert!(decode(&request()).is_ok());
        assert!(parse_pay(br#"{"rpcPort":12345,"memo":"synthetic","amountZat":100000}"#).is_ok());
    }

    #[test]
    fn alternate_network_pool_schema_and_uppercase_are_rejected() {
        for (field, value) in [
            ("network", "mainnet"),
            ("pool", "orchard"),
            ("schema", "other"),
            ("txid", &"AB".repeat(32)),
            ("ock", &"CD".repeat(32)),
        ] {
            let mut input = request();
            input["receipt"][field] = json!(value);
            assert!(matches!(decode(&input), Err(Failure::Receipt)));
        }
    }

    #[test]
    fn unknown_duplicate_and_trailing_fields_are_rejected() {
        let mut input = request();
        input["receipt"]["secret"] = json!("never log this");
        assert!(matches!(decode(&input), Err(Failure::Input)));
        let trailing = format!("{} {{}}", request());
        assert!(matches!(
            parse_verify(trailing.as_bytes()),
            Err(Failure::Input)
        ));
        let duplicate = br#"{"rpcPort":12345,"rpcPort":1,"memo":"x","amountZat":1}"#;
        assert!(matches!(parse_pay(duplicate), Err(Failure::Input)));
    }

    #[test]
    fn invalid_invoice_and_port_never_reach_rpc() {
        for invalid in [json!(0), json!(-1), json!(1.5), json!(MAX_AMOUNT + 1)] {
            let mut input = request();
            input["expected"]["amountZat"] = invalid;
            assert!(matches!(decode(&input), Err(Failure::Input)));
        }
        let mut input = request();
        input["rpcPort"] = json!(0);
        assert!(matches!(decode(&input), Err(Failure::Input)));
        input = request();
        input["expected"]["memo"] = json!("x".repeat(513));
        assert!(matches!(decode(&input), Err(Failure::Input)));
        assert!(matches!(
            parse_verify(&vec![b' '; MAX_INPUT + 1]),
            Err(Failure::Input)
        ));
    }
}
