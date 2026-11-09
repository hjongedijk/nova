/**
 * Sessions whose "user" turns were not typed by the owner: agent goals, autonomy and objectives,
 * proactive prompts, the autopilot, text messages from SIP contacts and phone callers. Their turns
 * never write durable memory, never teach corrections and never tune the autopilot.
 */
export const NOT_OWNER_SESSION =
  /^(?:agent_|proactive_|autopilot|autonomy_|objective_|sipchat_|phone_)/;

export const isOwnerSession = (sessionId: string): boolean =>
  !NOT_OWNER_SESSION.test(sessionId);
