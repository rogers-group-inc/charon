/**
 * src/services/directoryTypes.ts — Shared shape for discovered directory data.
 *
 * Every directory source (AD/LDAP, Entra ID, Intune) normalizes its results to
 * this shape before persistence as DirectoryObject rows (the tag-source mirror).
 */

export interface DiscoveredDirectoryObject {
  kind: "user" | "group" | "ou";
  /** Stable per-source id (objectGUID hex / Entra object id / DN fallback). */
  externalId: string;
  name: string;
  /** UPN/sAMAccountName for users; DN/group id for groups/OUs. */
  identifier?: string;
  parentOu?: string;
  /** Raw attributes used by custom-group rules (department, memberOf, …). */
  attributes: Record<string, unknown>;
}
