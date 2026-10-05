/** A model or provider as the free-routing policy file describes it. */
export interface FreeCandidate {
  provider: string;
  modelId?: string;
  freeType?: string;
  permanent?: boolean;
  billingVerified?: boolean;
  hardStopGuaranteed?: boolean;
  accountFreeVerified?: boolean;
  nativeAutoEligible?: boolean;
  nativeQuota?: { status?: string; fetchedAt?: string };
  tos?: string;
  local?: boolean;
  promotional?: boolean;
  paid?: boolean;
  price?: number;
  modelExcluded?: boolean;
  exclusionReason?: string;
  anonymous?: boolean;
  officialSource?: unknown;
}

export interface FreeAccess {
  category: string;
  allowed: boolean;
  reason: string;
}

/** Whether a model may be used at no cost. A policy gate, not a router and not a second quota counter. */
export function classifyFreeAccess(
  candidate: FreeCandidate,
  now = Date.now(),
): FreeAccess {
  const {
    provider,
    modelId,
    freeType,
    permanent,
    billingVerified,
    hardStopGuaranteed,
    nativeQuota,
  } = candidate;
  if (["avoid", "ambiguous", "unknown"].includes(candidate.tos ?? ""))
    return {
      category: "TERMS_UNVERIFIED",
      allowed: false,
      reason: "Provider terms prohibit this use or remain unverified",
    };
  if (candidate.local)
    return {
      category: "LOCAL_EXCLUDED",
      allowed: false,
      reason: "No local AI fallback",
    };
  if (
    candidate.promotional ||
    freeType === "one-time-initial" ||
    freeType === "trial"
  )
    return {
      category: "TRIAL_ONLY",
      allowed: false,
      reason: "Nonrenewable or promotional access",
    };
  if (candidate.paid || (candidate.price ?? 0) > 0)
    return { category: "PAID", allowed: false, reason: "Paid model" };
  if (candidate.modelExcluded)
    return {
      category: "MODEL_EXCLUDED",
      allowed: false,
      reason:
        candidate.exclusionReason || "Model is incompatible or unavailable",
    };
  if (
    provider === "openrouter" &&
    (typeof modelId !== "string" || !modelId.endsWith(":free"))
  )
    return {
      category: "UNKNOWN",
      allowed: false,
      reason:
        "OpenRouter requires an exact :free model; auto routes are excluded",
    };
  if (
    freeType === "keyless" &&
    permanent === true &&
    candidate.anonymous === true &&
    candidate.officialSource
  )
    return {
      category: "FREE_KEYLESS",
      allowed: true,
      reason:
        "Documented recurring anonymous access without billing credentials",
    };
  if (
    /^recurring-/.test(freeType ?? "") &&
    billingVerified === true &&
    hardStopGuaranteed === true
  ) {
    if (candidate.accountFreeVerified === true)
      return {
        category: "FREE_RECURRING",
        allowed: nativeQuota?.status !== "EXHAUSTED",
        reason:
          "Operator confirmed billing disabled or hard free-tier limit; OmniRoute handles quota exhaustion",
      };
    const fresh =
      nativeQuota?.status === "SAFE" &&
      now - Date.parse(nativeQuota.fetchedAt ?? "") < 180_000;
    return {
      category: "FREE_RECURRING",
      allowed: fresh,
      reason: fresh
        ? "Verified free account and fresh native quota"
        : "Native quota unavailable, exhausted or stale",
    };
  }
  return {
    category: "UNKNOWN",
    allowed: false,
    reason:
      "Permanent free access, billing or a hard free limit cannot be verified",
  };
}
