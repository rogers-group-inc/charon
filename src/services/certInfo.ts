/**
 * src/services/certInfo.ts — TLS leaf-certificate inspection.
 *
 * Computes the leaf-cert SHA-256 fingerprint — THE value agents pin (the
 * Certificates tab surfaces it as the agent pin). Also extracts subject / SAN /
 * validity for display. Parsing uses Node's X509Certificate (no external dep).
 *
 * PQC note: pinning the leaf SHA-256 is unaffected by PQC. Hybrid KEX
 * (X25519MLKEM768) is negotiated by nginx/OpenSSL at the transport layer; the
 * pin stays valid across the classical→PQC-cert transition because we pin the
 * fingerprint, not the key type.
 */

import { X509Certificate, createHash } from "node:crypto";

export interface CertSummary {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  san: string[];
  /** Lowercase hex SHA-256 of the DER leaf cert — the agent pin. */
  sha256: string;
  /** Colon-separated uppercase form for display. */
  sha256Display: string;
}

export function parseCert(pem: string): CertSummary {
  const cert = new X509Certificate(pem);
  const der = cert.raw; // DER bytes
  const sha256 = createHash("sha256").update(der).digest("hex");
  const san = (cert.subjectAltName ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    san,
    sha256,
    sha256Display: sha256.toUpperCase().match(/.{2}/g)?.join(":") ?? sha256,
  };
}

/** Compute just the agent pin (lowercase hex SHA-256) from a PEM leaf cert. */
export function leafPin(pem: string): string {
  return parseCert(pem).sha256;
}

/** Basic sanity check that a PEM blob is a parseable certificate. */
export function isValidCertPem(pem: string): boolean {
  try {
    parseCert(pem);
    return true;
  } catch {
    return false;
  }
}
