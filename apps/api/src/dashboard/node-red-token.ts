import crypto from "node:crypto";

export function matchesNodeRedToken(
  authorization: string | undefined,
  expected: string,
): boolean {
  if (expected.length < 32) return false;
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  if (!match) return false;
  const received = Buffer.from(match[1]!);
  const secret = Buffer.from(expected);
  return (
    received.length === secret.length &&
    crypto.timingSafeEqual(received, secret)
  );
}
