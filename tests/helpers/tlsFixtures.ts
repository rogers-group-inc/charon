/**
 * tests/helpers/tlsFixtures.ts — two throwaway self-signed TLS certificates
 * for the pinning tests, minted in memory once per test process.
 *
 * Polaris commits these as tests/fixtures/tls-pin-{a,b}.{pem,key}. Charon is a
 * public repo and gitignores *.pem / *.key, so no private key — not even a
 * test one — is ever committed: the pair is generated at run time instead.
 */

import selfsigned from "selfsigned";

export interface TlsFixture {
  cert: string;
  key: string;
}

function mint(cn: string): TlsFixture {
  const pems = selfsigned.generate([{ name: "commonName", value: cn }], {
    days: 365,
    keySize: 2048,
    algorithm: "sha256",
  });
  return { cert: pems.cert, key: pems.private };
}

/** Certificate A: the one a test pins first. */
export const tlsPinA: TlsFixture = mint("charon-tls-pin-test-a");
/** Certificate B: a DIFFERENT certificate for the same host — the "changed" one. */
export const tlsPinB: TlsFixture = mint("charon-tls-pin-test-b");
