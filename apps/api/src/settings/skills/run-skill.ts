import { sendRequest } from "../../core/security/safe-request.js";
import {
  pick,
  renderRequest,
  type StoredWebhookSkill,
  validateArguments,
} from "./skills.js";

export interface SkillOutcome {
  ok: boolean;
  error?: string;
  verified?: boolean | null;
  result?: {
    status: number;
    untrusted: true;
    response: unknown;
    note?: string;
    location?: string;
    truncated?: boolean;
  };
}

/** Run a webhook skill. Shared by the tool, the "Test" button and the data panels. */
export async function runSkill(
  skill: StoredWebhookSkill,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SkillOutcome> {
  const problems = validateArguments(skill, args);
  if (problems.length) return { ok: false, error: problems.join(" ") };
  let response;
  try {
    const request = renderRequest(skill, args);
    response = await sendRequest(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      timeoutMs: skill.http.timeoutMs,
      allowPrivate: skill.http.allowPrivate,
      signal,
    });
  } catch (error) {
    if (signal?.aborted || (error as Error)?.name === "AbortError")
      return { ok: false, error: "De aanroep duurde te lang." };
    return {
      ok: false,
      error: String(
        (error as Error)?.message || "De aanroep is mislukt.",
      ).slice(0, 200),
    };
  }
  let data: unknown = null;
  if (/json/i.test(response.contentType)) {
    try {
      data = JSON.parse(response.text);
    } catch {
      data = null;
    }
  }
  const picked = skill.http.extract ? pick(data, skill.http.extract) : data;
  const shown =
    picked !== undefined && picked !== null
      ? picked
      : response.text.slice(0, 4000);
  const result = {
    status: response.status,
    untrusted: true as const,
    ...(skill.http.extract && picked === undefined
      ? {
          note: `Het pad “${skill.http.extract}” komt niet voor in het antwoord.`,
        }
      : {}),
    response: typeof shown === "string" ? shown.slice(0, 4000) : shown,
    ...(response.location ? { location: response.location } : {}),
    ...(response.truncated ? { truncated: true } : {}),
  };
  if (response.status >= 400)
    return {
      ok: false,
      error: `De dienst antwoordde met HTTP ${response.status}.`,
      result,
    };
  return { ok: true, verified: null, result };
}
