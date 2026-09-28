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

/// Verifies node acceptance and selected payment content, never claimant identity.
pub fn verify(input: VerifyInput) -> Result<Evidence> {
    let rpc = Rpc::new(input.rpc_port)?;
    let tip = rpc.isolated_height(false)?;
    let raw = rpc.receipt_transaction(&input.receipt.txid)?;
    let confirmed = raw
        .get("confirmations")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if confirmed == 0 {
        return Err(Failure::Receipt);
    }
    let block_hash = raw
        .get("blockhash")
        .and_then(Value::as_str)
        .ok_or(Failure::Receipt)?;
    if !lower_hex(block_hash, 32) {
        return Err(Failure::Unavailable);
    }
    let tx = decode_transaction(
        raw.get("hex")
            .and_then(Value::as_str)
            .ok_or(Failure::Unavailable)?,
    )?;
    if tx.txid().to_string() != input.receipt.txid
        || raw.get("txid").and_then(Value::as_str) != Some(input.receipt.txid.as_str())
    {
        return Err(Failure::Unavailable);
    }
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
    let height = block
        .get("height")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(Failure::Unavailable)?;
    let confirmations = tip
        .checked_sub(height)
        .and_then(|n| n.checked_add(1))
        .filter(|n| *n > 0)
        .ok_or(Failure::Receipt)?;
    if height == 0
        || confirmed != u64::from(confirmations)
        || block.get("confirmations").and_then(Value::as_u64) != Some(u64::from(confirmations))
        || block.get("hash").and_then(Value::as_str) != Some(block_hash)
        || !block
            .get("tx")
            .and_then(Value::as_array)
            .is_some_and(|ids| {
                ids.iter()
                    .any(|id| id.as_str() == Some(input.receipt.txid.as_str()))
            })
        || rpc.call("getblockhash", json!([height]))?.as_str() != Some(block_hash)
    {
        return Err(Failure::Receipt);
    }

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
