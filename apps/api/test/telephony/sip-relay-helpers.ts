/** Raw SIP text helpers shared by the relay unit tests and the real-Asterisk lab. */
export const crlf = (lines: string[]) => lines.join("\r\n");

export function sipRequest(
  method: string,
  headers: string[],
  body = "",
  uri = "sip:nova-techlepp@sip.linphone.org",
): string {
  return crlf([
    `${method} ${uri} SIP/2.0`,
    ...headers,
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ]);
}

export function messageRequest(
  type: string | null,
  body: string,
  id = "m1",
  extra: string[] = [],
  domain = "sip.linphone.org",
): string {
  return sipRequest(
    "MESSAGE",
    [
      `Via: SIP/2.0/TCP 203.0.113.9:5060;branch=z9hG4bK${id};rport`,
      "Max-Forwards: 70",
      `From: "Tester" <sip:tester@${domain}>;tag=f${id}`,
      `To: <sip:nova-techlepp@${domain}>`,
      `Call-ID: ${id}@flexisip`,
      "CSeq: 1 MESSAGE",
      ...(type ? [`Content-Type: ${type}`] : []),
      ...extra,
    ],
    body,
    `sip:nova-techlepp@${domain}`,
  );
}

export function cpim(
  inner: string | null,
  body: string,
  eol = "\r\n",
  innerHeaders: string[] = [],
  domain = "sip.linphone.org",
): string {
  return [
    `From: <sip:tester@${domain}>`,
    `To: <sip:nova-techlepp@${domain}>`,
    "DateTime: 2026-10-17T10:00:00Z",
    "NS: imdn <urn:ietf:params:imdn>",
    "imdn.Message-ID: abc",
    "",
    ...(inner ? [`Content-Type: ${inner}`] : []),
    ...innerHeaders,
    "",
    body,
  ].join(eol);
}
