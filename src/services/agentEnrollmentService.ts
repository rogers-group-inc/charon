/**
 * src/services/agentEnrollmentService.ts — Invitation → bearer enrollment.
 *
 * The agent posts a one-time invitation code + device info. We consume the code
 * (atomic, capped), create/attach an Endpoint row, issue a long-lived bearer
 * (stored hashed), and return the bearer + the server leaf-cert SHA-256 pin the
 * agent must pin going forward (dual-pin during rotation). The agent does NOT
 * trust system roots — it trusts only the returned pin(s).
 */

import { prisma } from "../db.js";
import { consumeCode } from "./invitationCodeService.js";
import { issueBearer } from "./agentTokenService.js";
import { getAgentCertPins } from "./certPinService.js";
import { logEvent } from "./eventService.js";
import { markDeploymentEnrolled } from "./agentDeployService.js";
import { AppError } from "../utils/errors.js";

export interface EnrollInput {
  code: string;
  hostname?: string;
  osPlatform?: string;
  osVersion?: string;
  arch?: string;
  agentVersion?: string;
  /** Leaf-cert SHA-256 the agent observed; when sent it must be an agent pin. */
  observedFingerprint?: string;
}

export interface EnrollResult {
  endpointId: string;
  bearerToken: string; // shown once to the agent
  serverCertPins: string[]; // SHA-256 hex pins (canonical + staged)
}

export async function enroll(input: EnrollInput, ip: string | null): Promise<EnrollResult> {
  const invitationCodeId = await consumeCode(input.code);

  const pins = await getAgentCertPins();

  // Polaris's enroll check: an agent that pinned from its first request reports
  // the leaf it saw. One that is not an agent pin means it reached something
  // other than this server's certificate — refuse, and leave the code spent
  // (consumed above) so a code that leaked through that path cannot be replayed.
  if (input.observedFingerprint && !pins.includes(input.observedFingerprint.toLowerCase())) {
    await logEvent({
      level: "warning",
      action: "endpoint.enroll_pin_mismatch",
      resourceType: "invitation",
      resourceId: invitationCodeId,
      resourceName: input.hostname,
      message: `Enrollment of "${input.hostname ?? "unknown"}" refused: it observed a certificate that is not an agent pin — the code is spent`,
      details: { observed: input.observedFingerprint.toLowerCase(), ip },
    });
    throw new AppError(403, "The certificate this agent observed is not one of the server's agent pins");
  }

  const endpoint = await prisma.endpoint.create({
    data: {
      hostname: input.hostname ?? null,
      status: "enrolled",
      osPlatform: input.osPlatform ?? null,
      osVersion: input.osVersion ?? null,
      arch: input.arch ?? null,
      agentVersion: input.agentVersion ?? null,
      invitationCodeId,
      lastSeenIp: ip,
      serverCertFingerprint: pins[0] ?? null,
      additionalCertFingerprints: pins.slice(1),
    },
  });

  const bearerToken = await issueBearer(endpoint.id);

  // A code minted by a push deployment: link the Endpoint, mark it active.
  await markDeploymentEnrolled(invitationCodeId, endpoint.id, input.agentVersion);

  await logEvent({
    action: "endpoint.enrolled",
    resourceType: "endpoint",
    resourceId: endpoint.id,
    resourceName: input.hostname ?? endpoint.id,
    message: `Endpoint "${input.hostname ?? endpoint.id}" enrolled (${input.osPlatform ?? "unknown"})`,
  });

  return { endpointId: endpoint.id, bearerToken, serverCertPins: pins };
}
