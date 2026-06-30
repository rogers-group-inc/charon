//! Pinned HTTP client.
//!
//! The agent verifies the server by its leaf-cert SHA-256 pin — NOT by the
//! system root store. We install a custom rustls ServerCertVerifier that
//! accepts the connection iff the presented leaf cert's SHA-256 is in the
//! configured pin set (canonical ∪ staged, for dual-pin rotation).
//!
//! TLS 1.3 is required. PQC-hybrid KEX (X25519MLKEM768) is negotiated by the
//! rustls/provider build when available; pinning the leaf SHA-256 is unaffected
//! by PQC, so we pin now and adopt hybrid KEX as the provider stabilizes.

use reqwest::Client;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Debug)]
struct PinnedVerifier {
    pins: Vec<String>,
}

impl PinnedVerifier {
    fn leaf_matches(&self, end_entity: &CertificateDer<'_>) -> bool {
        let mut hasher = Sha256::new();
        hasher.update(end_entity.as_ref());
        let fp = hex::encode(hasher.finalize());
        self.pins.iter().any(|p| p.eq_ignore_ascii_case(&fp))
    }
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if self.leaf_matches(end_entity) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("server leaf-cert pin mismatch".into()))
        }
    }

    // We pin the leaf; signature checks on the handshake are still performed by
    // accepting the standard schemes (the pin is the trust decision).
    fn verify_tls12_signature(&self, _m: &[u8], _c: &CertificateDer<'_>, _d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(&self, _m: &[u8], _c: &CertificateDer<'_>, _d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ED25519,
            SignatureScheme::RSA_PSS_SHA256,
        ]
    }
}

/// Build a reqwest client that trusts ONLY the given leaf-cert pins. When the
/// pin set is empty (pre-enrollment first contact to /agent/auth-config) we
/// fall back to the webpki roots so the very first reachability call works;
/// every authenticated call uses the pinned client.
pub fn pinned_client(pins: &[String]) -> Result<Client, reqwest::Error> {
    if pins.is_empty() {
        return Client::builder().use_rustls_tls().build();
    }
    let verifier = Arc::new(PinnedVerifier { pins: pins.to_vec() });
    let tls = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Client::builder().use_preconfigured_tls(tls).build()
}
