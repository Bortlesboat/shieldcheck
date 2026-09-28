//! The generic upstream transaction builder requires Sapling prover types even
//! with its Sapling builder disabled. These types cannot produce any proof.
//! Every method fails closed; Ironwood proofs use the real upstream Halo 2 prover.

use sapling::{
    Diversifier, MerklePath, PaymentAddress, ProofGenerationKey, Rseed,
    bundle::GrothProofBytes,
    circuit,
    keys::EphemeralSecretKey,
    prover::{OutputProver, SpendProver},
    value::{NoteValue, ValueCommitTrapdoor},
};

pub struct DisabledSapling;

impl SpendProver for DisabledSapling {
    type Proof = std::convert::Infallible;

    fn prepare_circuit(
        _: ProofGenerationKey,
        _: Diversifier,
        _: Rseed,
        _: NoteValue,
        _: jubjub::Fr,
        _: ValueCommitTrapdoor,
        _: bls12_381::Scalar,
        _: MerklePath,
    ) -> Option<circuit::Spend> {
        None
    }

    fn create_proof<R: rand::RngCore>(&self, _: circuit::Spend, _: &mut R) -> Self::Proof {
        panic!("disabled pool")
    }

    fn encode_proof(proof: Self::Proof) -> GrothProofBytes {
        match proof {}
    }
}

impl OutputProver for DisabledSapling {
    type Proof = std::convert::Infallible;

    fn prepare_circuit(
        _: &EphemeralSecretKey,
        _: PaymentAddress,
        _: jubjub::Fr,
        _: NoteValue,
        _: ValueCommitTrapdoor,
    ) -> circuit::Output {
        panic!("disabled pool")
    }

    fn create_proof<R: rand::RngCore>(&self, _: circuit::Output, _: &mut R) -> Self::Proof {
        panic!("disabled pool")
    }

    fn encode_proof(proof: Self::Proof) -> GrothProofBytes {
        match proof {}
    }
}
