import crypto from "node:crypto";
export interface CredentialConnection {
  id: string;
  provider: string;
  auth_type: string | null;
  api_key: string | null;
}
/** Private proof of the exact API-key account; never return credential material. */
export function connectionFingerprint(row: CredentialConnection): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([row.id, row.provider, row.auth_type, row.api_key]))
    .digest("hex");
}
