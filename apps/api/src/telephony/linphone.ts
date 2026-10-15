import { SIP_PORT } from "./asterisk-config.js";
import type { Extension } from "./telephony.types.js";

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/**
 * Linphone remote-provisioning document (lpconfig) that registers one extension at NOVA's Asterisk.
 * Linphone applies it when the user scans the QR code or opens the provisioning link. Contains the
 * SIP password: only hand it out over the short-lived one-time link or the PIN-protected download.
 */
export function linphoneProvisioning(
  extension: Pick<Extension, "id" | "name" | "secret">,
  host: string,
  port = SIP_PORT,
): string {
  const domain = `${host}:${port}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<config xmlns="http://www.linphone.org/xsds/lpconfig.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.linphone.org/xsds/lpconfig.xsd lpconfig.xsd">
  <section name="proxy_0">
    <entry name="reg_proxy" overwrite="true">&lt;sip:${escapeXml(domain)};transport=udp&gt;</entry>
    <entry name="reg_route" overwrite="true">&lt;sip:${escapeXml(domain)};transport=udp&gt;</entry>
    <entry name="reg_identity" overwrite="true">"${escapeXml(extension.name)}" &lt;sip:${escapeXml(extension.id)}@${escapeXml(host)}&gt;</entry>
    <entry name="reg_expires" overwrite="true">600</entry>
    <entry name="reg_sendregister" overwrite="true">1</entry>
    <entry name="publish" overwrite="true">0</entry>
    <entry name="quality_reporting_enabled" overwrite="true">0</entry>
  </section>
  <section name="auth_info_0">
    <entry name="username" overwrite="true">${escapeXml(extension.id)}</entry>
    <entry name="passwd" overwrite="true">${escapeXml(extension.secret)}</entry>
  </section>
  <section name="sip">
    <entry name="default_proxy" overwrite="true">0</entry>
  </section>
</config>
`;
}
