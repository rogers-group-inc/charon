/**
 * src/utils/agentSilence.ts — when an agent's silence means "offline".
 *
 * Ported from polaris (its business rule 86), cut to Charon's question: an
 * enrolled agent pushes heartbeats (HTTP, every `heartbeatIntervalSec`) and may
 * hold a WebSocket. An agent whose host died, lost its network or had the
 * agent stopped pushes NOTHING — so without this its Endpoint stayed `online`
 * forever (the WS close only covers agents that had a socket).
 *
 * Two things must NOT be read as the host's silence, because Charon caused them:
 *   - this process was not running — the clock starts no earlier than
 *     `listeningSince` (process boot), so a restart does not accuse agents that
 *     simply have not reconnected yet;
 *   - Charon could not RECEIVE — when no enrolled agent anywhere has reported
 *     within the window, the ingest (web role, proxy, the server's network) is
 *     what is down: `fleetDark`, change nothing. A fleet of one cannot tell the
 *     two apart, so the guard needs a second enrolled agent to abstain.
 * Pure.
 */

/**
 * How long an agent may go without any bearer call before it counts as
 * offline: two heartbeat intervals, never less than one interval plus a
 * minute. At the 60 s default it is 120 s.
 */
export function silenceWindowMs(intervalSeconds: number): number {
  const sec = Math.max(1, intervalSeconds);
  return Math.max(2 * sec, sec + 60) * 1000;
}

export interface SilenceCutoff {
  /** Mark `online` endpoints last seen before this as offline — or null to change nothing. */
  cutoff: Date | null;
  fleetDark: boolean;
}

/**
 * The cutoff for this tick. `newestSeenAt` is the most recent lastSeenAt of
 * any reporting endpoint; `reportingCount` how many are expected to report.
 */
export function silenceCutoff(input: {
  now: number;
  listeningSince: number;
  intervalSeconds: number;
  newestSeenAt: Date | null;
  reportingCount: number;
}): SilenceCutoff {
  const window = silenceWindowMs(input.intervalSeconds);
  // Not listening for a whole window yet: nobody can be judged.
  if (input.now - input.listeningSince < window) return { cutoff: null, fleetDark: false };
  const fleetDark =
    input.reportingCount >= 2 &&
    (!input.newestSeenAt || input.now - input.newestSeenAt.getTime() > window);
  if (fleetDark) return { cutoff: null, fleetDark: true };
  return { cutoff: new Date(Math.max(input.now - window, input.listeningSince)), fleetDark: false };
}
