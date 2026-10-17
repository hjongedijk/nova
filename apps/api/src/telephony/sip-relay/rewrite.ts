import { NOTIFICATION_TYPES, parseContentType, parseCpim } from "./cpim.js";
import {
  header,
  okResponse,
  type SipMessage,
  withBody,
} from "./sip-message.js";

/** What the relay does with one Flexisip-to-Asterisk message. Only requests of method MESSAGE are ever changed. */
export type InboundDecision =
  | { action: "forward"; bytes: Buffer; rewritten: boolean }
  | {
      action: "answer";
      response: Buffer;
      /** "notification": typing or delivery report; "unreadable": something NOVA cannot read as text. */
      category: "notification" | "unreadable";
      contentType: string;
      reason: string;
    };

export function decideInbound(message: SipMessage): InboundDecision {
  const untouched: InboundDecision = {
    action: "forward",
    bytes: message.raw,
    rewritten: false,
  };
  if (!message.isRequest || message.method !== "MESSAGE") return untouched;
  const contentType = header(message, "content-type");
  if (!contentType) return untouched;
  const { type } = parseContentType(contentType);
  if (type === "text/plain") return untouched;
  const answer = (
    category: "notification" | "unreadable",
    reason: string,
  ): InboundDecision => ({
    action: "answer",
    response: okResponse(message),
    category,
    contentType: type,
    reason,
  });
  if (type === "message/cpim") {
    const result = parseCpim(message.body);
    if (result.kind === "text")
      return {
        action: "forward",
        bytes: withBody(message, "text/plain;charset=UTF-8", result.body),
        rewritten: true,
      };
    if (result.kind === "notification")
      return answer("notification", "cpim notification");
    return answer("unreadable", result.reason);
  }
  if (NOTIFICATION_TYPES.has(type)) return answer("notification", type);
  return answer("unreadable", `type ${type || "unknown"}`);
}
