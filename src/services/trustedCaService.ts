/**
 * src/services/trustedCaService.ts — operator-uploaded trusted CA certificates
 * (Server Settings → Web Server → Trusted Certificate Authorities).
 *
 * Ported from polaris serverSettingsService (listCertificates / addCertificate /
 * deleteCertificate): one Setting row, an array of records. Charon adaptations:
 *   - CA records only. The server leaf is managed by the Rotate-certificate
 *     flow (dual-pin), never by this list; private keys are refused.
 *   - subject / issuer / expiry are parsed with X509Certificate (polaris's
 *     regex placeholder left them null).
 *   - The PEMs are CONSUMED: services/httpClient.ts adds them to the system
 *     roots for every verifying outbound call (FortiGate / FortiManager /
 *     Entra), so an internal-CA-signed appliance verifies without turning
 *     verification off.
 */

import { X509Certificate, randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";

export interface CertificateRecord {
  id: string;
  category: "ca";
  type: "cert";
  name: string;
  subject: string | null;
  issuer: string | null;
  expiresAt: string | null;
  fingerprint: string | null;
  uploadedAt: string;
  pem: string;
}

const KEY = "trustedCertificates";

async function readAll(): Promise<CertificateRecord[]> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  return Array.isArray(row?.value) ? (row!.value as unknown as CertificateRecord[]) : [];
}

async function writeAll(certs: CertificateRecord[]): Promise<void> {
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: certs as any }, update: { value: certs as any } });
}

export async function listTrustedCas(): Promise<CertificateRecord[]> {
  return readAll();
}

/** All CA PEMs (for the outbound TLS trust store). */
export async function getTrustedCaPems(): Promise<string[]> {
  return (await readAll()).map((c) => c.pem).filter(Boolean);
}

/** DER uploads (.der/.cer) become PEM; PEM passes through. */
export function bufferToPem(buf: Buffer): string {
  const text = buf.toString("utf-8");
  if (text.includes("-----BEGIN ")) return text;
  const lines = buf.toString("base64").match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** Strip control characters from an uploader-chosen display name. */
export function cleanName(name: string): string {
  return String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
}

export function describeCaPem(pem: string): Pick<CertificateRecord, "subject" | "issuer" | "expiresAt" | "fingerprint"> {
  if (/PRIVATE KEY/.test(pem)) throw new AppError(400, "That file is a private key — upload the CA certificate only");
  let x: X509Certificate;
  try {
    x = new X509Certificate(pem);
  } catch {
    throw new AppError(400, "File is not a valid PEM/DER certificate");
  }
  const t = Date.parse(x.validTo);
  return {
    subject: x.subject.replace(/\n/g, ", "),
    issuer: x.issuer.replace(/\n/g, ", "),
    expiresAt: Number.isNaN(t) ? null : new Date(t).toISOString(),
    fingerprint: x.fingerprint256.replace(/:/g, "").toLowerCase(),
  };
}

export async function addTrustedCa(filename: string, pem: string): Promise<CertificateRecord> {
  const meta = describeCaPem(pem);
  const certs = await readAll();
  if (meta.fingerprint && certs.some((c) => c.fingerprint === meta.fingerprint)) {
    throw new AppError(409, "That CA certificate is already trusted");
  }
  const record: CertificateRecord = {
    id: randomUUID(),
    category: "ca",
    type: "cert",
    name: cleanName(filename) || "certificate",
    ...meta,
    uploadedAt: new Date().toISOString(),
    pem,
  };
  certs.push(record);
  await writeAll(certs);
  return record;
}

/** Returns the removed record, or null when the id is unknown. */
export async function deleteTrustedCa(id: string): Promise<CertificateRecord | null> {
  const certs = await readAll();
  const target = certs.find((c) => c.id === id) ?? null;
  if (!target) return null;
  await writeAll(certs.filter((c) => c.id !== id));
  return target;
}
