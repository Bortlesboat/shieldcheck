use std::{convert::Infallible, io::Cursor};

use incrementalmerkletree::{frontier::CommitmentTree, witness::IncrementalWitness};
use orchard::{
    Anchor,
    keys::{FullViewingKey, Scope, SpendAuthorizingKey, SpendingKey},
    note_encryption::IronwoodDomain,
    tree::MerkleHashOrchard,
};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use zcash_note_encryption::{
    Domain, EphemeralKeyBytes, OutgoingCipherKey, try_output_recovery_with_ock,
};
use zcash_primitives::transaction::{
    Transaction, TxVersion,
    builder::{BuildConfig, Builder, BundlePadding},
    fees::fixed,
};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, NetworkType},
    local_consensus::LocalNetwork,
    memo::MemoBytes,
    value::Zatoshis,
};
use zcash_transparent::{
    address::TransparentAddress, builder::TransparentSigningSet, bundle::OutPoint,
};

use crate::{
    contract::{
        BRANCH, Evidence, Expected, Failure, GENESIS, PayInput, Receipt, Result, VerifyInput,
        lower_hex,
    },
    no_sapling::DisabledSapling,
    rpc::Rpc,
};

// One transparent input plus two padded Ironwood actions needs three ZIP 317
// logical actions for the funding shield. The payment may safely pay the same fee.
const FEE: u64 = 15_000;
const MAX_TRANSACTION_BYTES: usize = 2_000_000;

fn params() -> LocalNetwork {
    let first = Some(BlockHeight::from_u32(1));
    LocalNetwork {
        overwinter: first,
        sapling: first,
        blossom: first,
        heartwood: first,
        canopy: first,
        nu5: first,
        nu6: first,
        nu6_1: first,
        nu6_2: first,
        nu6_3: first,
    }
}

fn amount(value: u64) -> Result<Zatoshis> {
    Zatoshis::from_u64(value).map_err(|_| Failure::Unavailable)
}

fn builder(height: u32, anchor: Anchor) -> Builder<LocalNetwork, ()> {
    Builder::new(
        params(),
        height.into(),
        BuildConfig::Standard {
            sapling_anchor: None,
            orchard_anchor: None,
            ironwood_anchor: Some(anchor),
            orchard_padding: BundlePadding::DEFAULT,
            ironwood_padding: BundlePadding::DEFAULT,
        },
    )
}

fn random_spending_key() -> SpendingKey {
    loop {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        if let Some(key) = Option::from(SpendingKey::from_bytes(bytes)) {
            return key;
        }
    }
}

fn decode_transaction(encoded: &str) -> Result<Transaction> {
    if encoded.len() > MAX_TRANSACTION_BYTES * 2 || !encoded.len().is_multiple_of(2) {
        return Err(Failure::Unavailable);
    }
    let bytes = hex::decode(encoded).map_err(|_| Failure::Unavailable)?;
    let mut cursor = Cursor::new(&bytes);
    let transaction =
        Transaction::read(&mut cursor, BranchId::Nu6_3).map_err(|_| Failure::Unavailable)?;
    if cursor.position() != bytes.len() as u64 {
        return Err(Failure::Unavailable);
    }
    Ok(transaction)
}

fn fetched_transaction(rpc: &Rpc, txid: &str) -> Result<Transaction> {
    let encoded = rpc.call("getrawtransaction", json!([txid, 0]))?;
    let tx = decode_transaction(encoded.as_str().ok_or(Failure::Unavailable)?)?;
    if tx.txid().to_string() != txid {
        return Err(Failure::Unavailable);
    }
    Ok(tx)
}

fn broadcast(rpc: &Rpc, tx: &Transaction) -> Result<String> {
    let mut bytes = Vec::new();
    tx.write(&mut bytes).map_err(|_| Failure::Unavailable)?;
    let txid = tx.txid().to_string();
    let result = rpc.call("sendrawtransaction", json!([hex::encode(bytes)]))?;
    if result.as_str() != Some(txid.as_str()) {
        return Err(Failure::Unavailable);
    }
    Ok(txid)
}

fn confirm(rpc: &Rpc, txid: &str, miner: &str, target_height: u32) -> Result<()> {
    let hashes = rpc.mine(1, miner)?;
    if rpc.isolated_height(false)? != target_height {
        return Err(Failure::Unavailable);
    }
    let block = rpc.call("getblock", json!([&hashes[0], 1]))?;
    if !block
        .get("tx")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(txid)))
    {
        return Err(Failure::Unavailable);
    }
    Ok(())
}

fn recover_action<T>(
    action: &orchard::Action<T>,
    receipt: &Receipt,
    expected: &Expected,
) -> Result<()> {
    let bytes: [u8; 32] = hex::decode(&receipt.ock)
        .map_err(|_| Failure::Receipt)?
        .try_into()
        .map_err(|_| Failure::Receipt)?;
    let domain = IronwoodDomain::for_action(action);
    let (note, recipient, memo) = try_output_recovery_with_ock(
        &domain,
        &OutgoingCipherKey(bytes),
        action,
        &action.encrypted_note().out_ciphertext,
    )
    .ok_or(Failure::Receipt)?;
    let padded_memo =
        MemoBytes::from_bytes(expected.memo.as_bytes()).map_err(|_| Failure::Input)?;
    if hex::encode(recipient.to_raw_address_bytes()) != expected.recipient
        || note.value().inner() != expected.amount_zat
        || memo != padded_memo.into_bytes()
    {
        return Err(Failure::Receipt);
    }
    Ok(())
}

fn confirmed_transaction<'a>(raw: &'a Value, txid: &str) -> Result<(Transaction, u64, &'a str)> {
    // A successful RPC envelope must contain the requested binary transaction
    // before missing confirmation fields can mean a genuine mempool transaction.
    raw.as_object().ok_or(Failure::Unavailable)?;
    let tx = decode_transaction(
        raw.get("hex")
            .and_then(Value::as_str)
            .ok_or(Failure::Unavailable)?,
    )?;
    if tx.txid().to_string() != txid || raw.get("txid").and_then(Value::as_str) != Some(txid) {
        return Err(Failure::Unavailable);
    }
    let confirmations = raw
        .get("confirmations")
        .map(|v| v.as_u64().ok_or(Failure::Unavailable))
        .transpose()?;
    let height = raw
        .get("height")
        .map(|v| v.as_i64().ok_or(Failure::Unavailable))
        .transpose()?;
    let block_hash = raw
        .get("blockhash")
        .map(|v| {
            v.as_str()
                .filter(|s| lower_hex(s, 32))
                .ok_or(Failure::Unavailable)
        })
        .transpose()?;

    // Zebra 6.4.2 omits these three fields for mempool transactions and reports
    // height -1 / confirmations 0 for a side-chain transaction. Null fields,
    // invalid types and incomplete combinations are unavailable evidence.
    match (confirmations, height, block_hash) {
        (None, None, None) | (Some(0), None, None) | (Some(0), Some(-1), Some(_)) => {
            Err(Failure::Receipt)
        }
        (Some(count), Some(height), Some(hash))
            if (1..=u64::from(u32::MAX)).contains(&count)
                && (1..=i64::from(u32::MAX)).contains(&height) =>
        {
            Ok((tx, count, hash))
        }
        _ => Err(Failure::Unavailable),
    }
}

struct BlockEvidence<'a> {
    height: u32,
    confirmations: i64,
    hash: &'a str,
    transaction_ids: Vec<&'a str>,
}

fn block_evidence(block: &Value) -> Result<BlockEvidence<'_>> {
    let height = block
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(Failure::Unavailable)?;
    let confirmations = block
        .get("confirmations")
        .and_then(Value::as_i64)
        .filter(|n| (-1..=i64::from(u32::MAX)).contains(n))
        .ok_or(Failure::Unavailable)?;
    let hash = block
        .get("hash")
        .and_then(Value::as_str)
        .filter(|s| lower_hex(s, 32))
        .ok_or(Failure::Unavailable)?;
    let transaction_ids = block
        .get("tx")
        .and_then(Value::as_array)
        .filter(|ids| !ids.is_empty())
        .ok_or(Failure::Unavailable)?
        .iter()
        .map(|id| {
            id.as_str()
                .filter(|s| lower_hex(s, 32))
                .ok_or(Failure::Unavailable)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(BlockEvidence {
        height,
        confirmations,
        hash,
        transaction_ids,
    })
}

fn block_hash_result(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|s| lower_hex(s, 32))
        .ok_or(Failure::Unavailable)
}

fn check_inclusion(
    block: &BlockEvidence<'_>,
    canonical_hash: &str,
    expected_hash: &str,
    txid: &str,
    tip: u32,
    raw_height: u64,
    raw_confirmations: u64,
) -> Result<(u32, u32)> {
    let confirmations = tip
        .checked_sub(block.height)
        .and_then(|n| n.checked_add(1))
        .filter(|n| *n > 0)
        .ok_or(Failure::Receipt)?;
    if raw_height != u64::from(block.height) {
        return Err(Failure::Unavailable);
    }
    if block.height == 0
        || block.confirmations < 1
        || raw_confirmations != u64::from(confirmations)
        || block.confirmations != i64::from(confirmations)
        || block.hash != expected_hash
        || !block.transaction_ids.contains(&txid)
        || canonical_hash != expected_hash
    {
        return Err(Failure::Receipt);
    }
    Ok((block.height, confirmations))
}

/// Verifies node acceptance and selected payment content, never claimant identity.
pub fn verify(input: VerifyInput) -> Result<Evidence> {
    let rpc = Rpc::new(input.rpc_port)?;
    let tip = rpc.isolated_height(false)?;
    let raw = rpc.receipt_transaction(&input.receipt.txid)?;
    let (tx, confirmed, block_hash) = confirmed_transaction(&raw, &input.receipt.txid)?;
    if tx.version() != TxVersion::V6
        || tx.consensus_branch_id() != BranchId::Nu6_3
        || tx.transparent_bundle().is_some()
        || tx.sapling_bundle().is_some()
        || tx.orchard_bundle().is_some()
    {
        return Err(Failure::Receipt);
    }
    let action = tx
        .ironwood_bundle()
        .ok_or(Failure::Receipt)?
        .actions()
        .get(input.receipt.action_index)
        .ok_or(Failure::Receipt)?;
    recover_action(action, &input.receipt, &input.expected)?;

    let block = rpc.call("getblock", json!([block_hash, 1]))?;
    let block = block_evidence(&block)?;
    if block.confirmations < 1 || block.height == 0 || block.height > tip {
        return Err(Failure::Receipt);
    }
    let canonical = rpc.call("getblockhash", json!([block.height]))?;
    let canonical = block_hash_result(&canonical)?;
    let (height, confirmations) = check_inclusion(
        &block,
        canonical,
        block_hash,
        &input.receipt.txid,
        tip,
        raw["height"].as_u64().ok_or(Failure::Unavailable)?,
        confirmed,
    )?;

    Ok(Evidence {
        network: "regtest",
        pool: "ironwood",
        genesis: GENESIS,
        branch_id: BRANCH,
        txid: input.receipt.txid,
        block_hash: block_hash.to_owned(),
        block_height: height,
        confirmations,
        shielded_only: true,
    })
}

pub fn pay(input: PayInput) -> Result<Value> {
    let rpc = Rpc::new(input.rpc_port)?;
    rpc.isolated_height(true)?;
    let mempool = rpc.call("getrawmempool", json!([]))?;
    if mempool.as_array().is_none_or(|items| !items.is_empty()) {
        return Err(Failure::Unavailable);
    }

    let mut transparent_keys = TransparentSigningSet::new();
    let secret = loop {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        if let Ok(key) = secp256k1::SecretKey::from_slice(&bytes) {
            break key;
        }
    };
    let public = transparent_keys.add_key(secret);
    let miner = TransparentAddress::from_pubkey(&public);
    let miner_text = miner.to_zcash_address(NetworkType::Regtest).to_string();
    eprintln!("native: mining disposable funding");
    let mined = rpc.mine(101, &miner_text)?;
    if rpc.isolated_height(false)? != 101 {
        return Err(Failure::Unavailable);
    }
    let first_block = rpc.call("getblock", json!([&mined[0], 1]))?;
    let coinbase_id = first_block
        .get("tx")
        .and_then(Value::as_array)
        .filter(|ids| ids.len() == 1)
        .and_then(|ids| ids[0].as_str())
        .ok_or(Failure::Unavailable)?;
    let coinbase = fetched_transaction(&rpc, coinbase_id)?;
    let transparent = coinbase.transparent_bundle().ok_or(Failure::Unavailable)?;
    if !transparent.is_coinbase() || coinbase.ironwood_bundle().is_some() {
        return Err(Failure::Unavailable);
    }
    let (output_index, coin) = transparent
        .vout
        .iter()
        .enumerate()
        .find(|(_, output)| output.recipient_address() == Some(miner))
        .ok_or(Failure::Unavailable)?;
    let shielded_value = u64::from(coin.value())
        .checked_sub(FEE)
        .ok_or(Failure::Unavailable)?;
    let change = shielded_value
        .checked_sub(input.amount_zat)
        .and_then(|v| v.checked_sub(FEE))
        .filter(|v| *v > 0)
        .ok_or(Failure::Unavailable)?;

    let payer_key = random_spending_key();
    let payer = FullViewingKey::from(&payer_key);
    let payer_address = payer.address_at(0u32, Scope::External);
    let ovk = payer.to_ovk(Scope::External);
    let merchant = FullViewingKey::from(&random_spending_key()).address_at(0u32, Scope::External);
    let fee = fixed::FeeRule::non_standard(amount(FEE)?);
    let mut shield = builder(102, Anchor::empty_tree());
    shield
        .add_transparent_p2pkh_input(
            public,
            OutPoint::new(coinbase.txid().into(), output_index as u32),
            coin.clone(),
        )
        .map_err(|_| Failure::Unavailable)?;
    shield
        .add_ironwood_output::<Infallible>(
            Some(ovk.clone()),
            payer_address,
            amount(shielded_value)?,
            MemoBytes::empty(),
        )
        .map_err(|_| Failure::Unavailable)?;
    eprintln!("native: proving funding shield");
    let shielding = shield
        .build(
            &transparent_keys,
            &[],
            &[],
            OsRng,
            &DisabledSapling,
            &DisabledSapling,
            &fee,
        )
        .map_err(|_| Failure::Unavailable)?;
    let shield_index = shielding
        .ironwood_meta()
        .output_action_index(0)
        .ok_or(Failure::Unavailable)?;
    let shield_tx = shielding.transaction();
    let shield_txid = broadcast(&rpc, shield_tx)?;
    confirm(&rpc, &shield_txid, &miner_text, 102)?;

    let bundle = shield_tx.ironwood_bundle().ok_or(Failure::Unavailable)?;
    let (note, _, _) = bundle
        .decrypt_output_with_key(shield_index, &payer.to_ivk(Scope::External))
        .ok_or(Failure::Unavailable)?;
    let mut tree: CommitmentTree<MerkleHashOrchard, 32> = CommitmentTree::empty();
    let mut witness: Option<IncrementalWitness<MerkleHashOrchard, 32>> = None;
    for (index, action) in bundle.actions().iter().enumerate() {
        let leaf = MerkleHashOrchard::from_cmx(action.cmx());
        tree.append(leaf).map_err(|_| Failure::Unavailable)?;
        if let Some(witness) = witness.as_mut() {
            witness.append(leaf).map_err(|_| Failure::Unavailable)?;
        }
        if index == shield_index {
            witness = IncrementalWitness::from_tree(tree.clone());
        }
    }
    let witness = witness.ok_or(Failure::Unavailable)?;
    let mut payment = builder(103, tree.root().into());
    payment
        .add_ironwood_spend::<Infallible>(
            payer,
            note,
            witness.path().ok_or(Failure::Unavailable)?.into(),
        )
        .map_err(|_| Failure::Unavailable)?;
    payment
        .add_ironwood_output::<Infallible>(
            Some(ovk.clone()),
            merchant,
            amount(input.amount_zat)?,
            MemoBytes::from_bytes(input.memo.as_bytes()).map_err(|_| Failure::Input)?,
        )
        .map_err(|_| Failure::Unavailable)?;
    payment
        .add_ironwood_output::<Infallible>(
            Some(ovk.clone()),
            payer_address,
            amount(change)?,
            MemoBytes::empty(),
        )
        .map_err(|_| Failure::Unavailable)?;
    eprintln!("native: proving shielded payment");
    let built = payment
        .build(
            &TransparentSigningSet::new(),
            &[],
            &[SpendAuthorizingKey::from(&payer_key)],
            OsRng,
            &DisabledSapling,
            &DisabledSapling,
            &fee,
        )
        .map_err(|_| Failure::Unavailable)?;
    let action_index = built
        .ironwood_meta()
        .output_action_index(0)
        .ok_or(Failure::Unavailable)?;
    let tx = built.transaction();
    if tx.transparent_bundle().is_some() {
        return Err(Failure::Unavailable);
    }
    let txid = broadcast(&rpc, tx)?;
    let action = &tx.ironwood_bundle().ok_or(Failure::Unavailable)?.actions()[action_index];
    let ock = IronwoodDomain::derive_ock(
        &ovk,
        action.cv_net(),
        &action.cmx().to_bytes(),
        &EphemeralKeyBytes(action.encrypted_note().epk_bytes),
    );
    let receipt = Receipt {
        schema: "shieldcheck-receipt/v1".into(),
        network: "regtest".into(),
        pool: "ironwood".into(),
        txid,
        action_index,
        ock: hex::encode(ock.0),
    };
    let expected = Expected {
        recipient: hex::encode(merchant.to_raw_address_bytes()),
        amount_zat: input.amount_zat,
        memo: input.memo,
    };
    // Establish that the real transaction exists before testing unconfirmed rejection.
    // A missing transaction or failed RPC must not make this negative control pass.
    let pending = rpc.call("getrawmempool", json!([]))?;
    if !pending.as_array().is_some_and(|ids| {
        ids.iter()
            .any(|id| id.as_str() == Some(receipt.txid.as_str()))
    }) {
        return Err(Failure::Unavailable);
    }
    if !matches!(
        verify(VerifyInput {
            rpc_port: input.rpc_port,
            receipt: receipt.clone(),
            expected: expected.clone()
        }),
        Err(Failure::Receipt)
    ) {
        return Err(Failure::Unavailable);
    }
    eprintln!("native: unconfirmed receipt rejected");
    confirm(&rpc, &receipt.txid, &miner_text, 103)?;
    let evidence = verify(VerifyInput {
        rpc_port: input.rpc_port,
        receipt: receipt.clone(),
        expected: expected.clone(),
    })?;
    Ok(json!({"status":"created", "receipt":receipt, "expected":expected, "evidence":evidence}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchard::{
        builder::BundleType,
        bundle::{BundleVersion, Flags},
        value::NoteValue,
    };

    fn serialized_envelope() -> Value {
        use zcash_primitives::transaction::{Authorized, TransactionData};
        // A binary-serialized V6 transaction exercises envelope decoding only.
        // It is not a valid funded payment or settlement evidence.
        let tx = TransactionData::<Authorized>::from_parts_v6(
            BranchId::Nu6_3,
            0,
            150.into(),
            None,
            None,
            None,
            None,
        )
        .freeze()
        .unwrap();
        let mut bytes = Vec::new();
        tx.write(&mut bytes).unwrap();
        json!({"txid":tx.txid().to_string(), "hex":hex::encode(bytes)})
    }

    fn complete_block() -> Value {
        json!({"height":103, "confirmations":1, "hash":"ab".repeat(32),
            "tx":["cd".repeat(32), "ef".repeat(32)]})
    }

    #[test]
    fn every_canonical_block_field_must_be_complete_and_well_typed() {
        for field in ["height", "confirmations", "hash", "tx"] {
            let mut block = complete_block();
            block.as_object_mut().unwrap().remove(field);
            assert!(
                matches!(block_evidence(&block), Err(Failure::Unavailable)),
                "{field}"
            );
        }
        for (field, invalid) in [
            ("height", json!(-1)),
            ("height", json!("103")),
            ("confirmations", Value::Null),
            ("confirmations", json!("1")),
            ("confirmations", json!(-2)),
            ("hash", json!(true)),
            ("hash", json!("not a hash")),
            ("tx", Value::Null),
            ("tx", json!([])),
            ("tx", json!(["cd".repeat(32), 1])),
            ("tx", json!(["cd".repeat(32), "bad hash"])),
        ] {
            let mut block = complete_block();
            block[field] = invalid;
            assert!(
                matches!(block_evidence(&block), Err(Failure::Unavailable)),
                "{field}"
            );
        }
    }

    #[test]
    fn malformed_height_lookup_hash_is_unavailable() {
        for invalid in [
            Value::Null,
            json!({}),
            json!(1),
            json!(""),
            json!("AB".repeat(32)),
        ] {
            assert!(matches!(
                block_hash_result(&invalid),
                Err(Failure::Unavailable)
            ));
        }
    }

    #[test]
    fn well_formed_orphan_and_noncanonical_blocks_remain_receipt_rejections() {
        let raw = complete_block();
        let block = block_evidence(&raw).unwrap();
        let expected_hash = "ab".repeat(32);
        let txid = "cd".repeat(32);
        assert_eq!(
            check_inclusion(&block, &expected_hash, &expected_hash, &txid, 103, 103, 1),
            Ok((103, 1))
        );
        assert_eq!(
            check_inclusion(&block, &"00".repeat(32), &expected_hash, &txid, 103, 103, 1),
            Err(Failure::Receipt)
        );
        assert_eq!(
            check_inclusion(
                &block,
                &expected_hash,
                &expected_hash,
                &"00".repeat(32),
                103,
                103,
                1
            ),
            Err(Failure::Receipt)
        );
        let mut orphan = raw.clone();
        orphan["confirmations"] = json!(-1);
        assert_eq!(
            check_inclusion(
                &block_evidence(&orphan).unwrap(),
                &expected_hash,
                &expected_hash,
                &txid,
                103,
                103,
                1
            ),
            Err(Failure::Receipt)
        );
        // A malformed transaction member cannot be hidden by a valid orphan status.
        orphan["tx"] = json!(["cd".repeat(32), Value::Null]);
        assert!(matches!(block_evidence(&orphan), Err(Failure::Unavailable)));
    }

    #[test]
    fn malformed_successful_rpc_envelope_cannot_pass_an_unconfirmed_negative() {
        let valid = serialized_envelope();
        let txid = valid["txid"].as_str().unwrap();
        for malformed in [
            Value::Null,
            json!("unexpected"),
            json!({}),
            json!({"confirmations":0}),
            json!({"txid":txid}),
            json!({"txid":txid,"hex":"invalid"}),
        ] {
            assert!(matches!(
                confirmed_transaction(&malformed, txid),
                Err(Failure::Unavailable)
            ));
        }
        let mut wrong_id = valid.clone();
        wrong_id["txid"] = json!("00".repeat(32));
        assert!(matches!(
            confirmed_transaction(&wrong_id, txid),
            Err(Failure::Unavailable)
        ));
    }

    #[test]
    fn malformed_confirmation_metadata_is_unavailable() {
        let valid = serialized_envelope();
        let txid = valid["txid"].as_str().unwrap();
        for malformed in [Value::Null, json!("1"), json!(-1), json!(1.5)] {
            let mut raw = valid.clone();
            raw["confirmations"] = malformed;
            raw["blockhash"] = json!("ab".repeat(32));
            raw["height"] = json!(1);
            assert!(matches!(
                confirmed_transaction(&raw, txid),
                Err(Failure::Unavailable)
            ));
        }
        let mut partial = valid.clone();
        partial["confirmations"] = json!(1);
        assert!(matches!(
            confirmed_transaction(&partial, txid),
            Err(Failure::Unavailable)
        ));
    }

    #[test]
    fn valid_mempool_and_side_chain_envelopes_remain_receipt_rejections() {
        let mut raw = serialized_envelope();
        let txid = raw["txid"].as_str().unwrap().to_owned();
        assert!(matches!(
            confirmed_transaction(&raw, &txid),
            Err(Failure::Receipt)
        ));
        raw["confirmations"] = json!(0);
        raw["height"] = json!(-1);
        raw["blockhash"] = json!("ab".repeat(32));
        assert!(matches!(
            confirmed_transaction(&raw, &txid),
            Err(Failure::Receipt)
        ));
        raw["confirmations"] = json!(1);
        raw["height"] = json!(103);
        assert!(confirmed_transaction(&raw, &txid).is_ok());
    }

    #[test]
    fn real_ironwood_output_opening_checks_every_invoice_field() {
        let fvk = FullViewingKey::from(&random_spending_key());
        let address = fvk.address_at(0u32, Scope::External);
        let ovk = fvk.to_ovk(Scope::External);
        let mut builder = orchard::builder::Builder::new(
            BundleType::DEFAULT,
            BundleVersion::ironwood_v3(),
            Flags::SPENDS_DISABLED,
            Anchor::empty_tree(),
        )
        .unwrap();
        let memo = "test output";
        builder
            .add_output(
                Some(ovk.clone()),
                address,
                NoteValue::from_raw(100_000),
                MemoBytes::from_bytes(memo.as_bytes()).unwrap().into_bytes(),
            )
            .unwrap();
        // Proof generation is unnecessary for this decryption-boundary unit test.
        // Integration requires independently mined node-accepted transaction proofs.
        let (bundle, meta) = builder.build::<i64>(&mut OsRng).unwrap().unwrap();
        let index = meta.output_action_index(0).unwrap();
        let action = &bundle.actions()[index];
        let ock = IronwoodDomain::derive_ock(
            &ovk,
            action.cv_net(),
            &action.cmx().to_bytes(),
            &EphemeralKeyBytes(action.encrypted_note().epk_bytes),
        );
        let receipt = Receipt {
            schema: "shieldcheck-receipt/v1".into(),
            network: "regtest".into(),
            pool: "ironwood".into(),
            txid: "00".repeat(32),
            action_index: index,
            ock: hex::encode(ock.0),
        };
        let expected = Expected {
            recipient: hex::encode(address.to_raw_address_bytes()),
            amount_zat: 100_000,
            memo: memo.into(),
        };
        assert_eq!(recover_action(action, &receipt, &expected), Ok(()));
        let mut altered = expected.clone();
        altered.amount_zat += 1;
        assert_eq!(
            recover_action(action, &receipt, &altered),
            Err(Failure::Receipt)
        );
        altered = expected.clone();
        altered.memo.push('x');
        assert_eq!(
            recover_action(action, &receipt, &altered),
            Err(Failure::Receipt)
        );
        altered = expected.clone();
        altered.recipient = "00".repeat(43);
        assert_eq!(
            recover_action(action, &receipt, &altered),
            Err(Failure::Receipt)
        );
        let mut changed = receipt.clone();
        changed.ock = "00".repeat(32);
        assert_eq!(
            recover_action(action, &changed, &expected),
            Err(Failure::Receipt)
        );
        assert_eq!(
            recover_action(&bundle.actions()[1 - index], &receipt, &expected),
            Err(Failure::Receipt)
        );
    }

    #[test]
    fn malformed_node_transaction_is_unavailable_not_receipt_rejection() {
        for encoded in ["", "0", "00", "not-hex"] {
            assert!(matches!(
                decode_transaction(encoded),
                Err(Failure::Unavailable)
            ));
        }
    }
}
