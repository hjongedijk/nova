import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import net from "node:net";

export interface PlanAccount {
  id: string;
  provider: string;
  name: string;
  active: boolean;
  authType: string;
  credentialPresent: boolean;
  fingerprint: string;
}
export interface PlanModel {
  provider: string;
  modelId: string;
  name: string;
  freeType: string;
  tos: string;
}
export interface FreePolicyPlan {
  route: "auto";
  status: "OK";
  nativeFreeAccessPolicy: "strict";
  enabledModels: string[];
  verifiedProviders: string[];
  verifiedConnectionIds: string[];
  verifiedConnections: { id: string; provider: string; fingerprint: string }[];
  blockedProviders: string[];
  nativeModelAllowlist: string[];
  catalog: {
    provider: string;
    modelId: string;
    freeType: string;
    tos: string;
    billingVerified: true;
    hardStopGuaranteed: true;
    accountFreeVerified: true;
    evidenceSource: "operator-account";
    nativeAutoEligible: false;
    officialSource: string;
  }[];
  providers: [];
}

const acknowledgements = [
  "acknowledgeBillingDisabled",
  "acknowledgeHardStop",
  "acknowledgeTerms",
  "acknowledgeAllClients",
  "acknowledgeQuotaRefresh",
] as const;
const modelIdPattern = /^[a-zA-Z0-9_.:/@-]{1,200}$/;
const providerPattern = /^[a-zA-Z0-9_.-]{1,100}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(message: string): never {
  throw new ValidationError([message]);
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail("Kies accounts en modellen voor het gratis beleid.");
const exactFields = (
  value: Record<string, unknown>,
  fields: string[],
): void => {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !fields.includes(field))
  )
    fail("Gebruik alleen de gevraagde velden voor het gratis beleid.");
};

function source(value: unknown): string {
  const message =
    "Vul een officiële HTTPS-bron in zonder inloggegevens, query of fragment.";
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    value.trim() !== value ||
    sanitize(value) !== value
  )
    fail(message);
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.includes("?") ||
      value.includes("#") ||
      net.isIP(hostname) !== 0 ||
      !hostname.includes(".") ||
      /(?:^|\.)(?:localhost|local|internal)$/.test(hostname)
    )
      fail(message);
    if (url.href.length > 2048) fail(message);
    return url.href;
  } catch {
    return fail(message);
  }
}

/** Operator attestations form a draft; native routing eligibility still needs independent proof. */
export function buildFreePolicyPlan(
  input: unknown,
  accounts: PlanAccount[],
  models: PlanModel[],
  knownProviders: string[],
): FreePolicyPlan {
  const data = record(input);
  exactFields(data, ["selection", ...acknowledgements]);
  if (acknowledgements.some((field) => data[field] !== true))
    fail(
      "Bevestig facturering, harde gratis limieten, voorwaarden en de gevolgen voor alle clients en quota.",
    );
  if (
    !Array.isArray(data.selection) ||
    !data.selection.length ||
    data.selection.length > 20
  )
    fail("Kies één tot twintig gratis modellen.");
  if (knownProviders.some((provider) => !providerPattern.test(provider)))
    fail("De providerinventaris is ongeldig. Laad de accounts opnieuw.");

  const selectedAccounts = new Map<string, PlanAccount>();
  const selectedModels = new Map<string, FreePolicyPlan["catalog"][number]>();
  for (const raw of data.selection) {
    const selection = record(raw);
    exactFields(selection, ["connectionId", "modelId", "officialSource"]);
    if (
      typeof selection.connectionId !== "string" ||
      !uuidPattern.test(selection.connectionId) ||
      typeof selection.modelId !== "string" ||
      !modelIdPattern.test(selection.modelId)
    )
      fail("Kies een geldig account en een exact model uit de catalogus.");
    const matches = accounts.filter(
      (account) => account.id === selection.connectionId,
    );
    const account = matches[0];
    if (
      matches.length !== 1 ||
      !account ||
      account.active !== true ||
      account.authType !== "apikey" ||
      account.credentialPresent !== true ||
      !providerPattern.test(account.provider) ||
      !/^[a-f0-9]{64}$/.test(account.fingerprint)
    )
      fail(
        "Kies een actief API-key-account met gecontroleerde accountgegevens.",
      );
    const catalogMatches = models.filter(
      (model) =>
        model.provider === account.provider &&
        model.modelId === selection.modelId,
    );
    const model = catalogMatches[0];
    if (
      catalogMatches.length !== 1 ||
      !model ||
      !/^recurring-[a-z][a-z0-9-]*$/.test(model.freeType) ||
      !["ok", "caution"].includes(model.tos)
    )
      fail("Kies een terugkerend gratis model met aanvaardbare voorwaarden.");
    const prior = selectedAccounts.get(account.provider);
    if (prior && prior.id !== account.id)
      fail(
        "Kies per provider één account, zodat het gratis bewijs eenduidig blijft.",
      );
    const canonical = `${account.provider}/${model.modelId}`;
    if (selectedModels.has(canonical)) fail("Kies elk model slechts één keer.");
    selectedAccounts.set(account.provider, account);
    selectedModels.set(canonical, {
      provider: account.provider,
      modelId: model.modelId,
      freeType: model.freeType,
      tos: model.tos,
      billingVerified: true,
      hardStopGuaranteed: true,
      accountFreeVerified: true,
      evidenceSource: "operator-account",
      nativeAutoEligible: false,
      officialSource: source(selection.officialSource),
    });
  }
  const enabledModels = [...selectedModels.keys()].sort();
  const verifiedProviders = [...selectedAccounts.keys()].sort();
  const verifiedConnections = [...selectedAccounts.values()]
    .map(({ id, provider, fingerprint }) => ({ id, provider, fingerprint }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    route: "auto",
    status: "OK",
    nativeFreeAccessPolicy: "strict",
    enabledModels,
    verifiedProviders,
    verifiedConnectionIds: verifiedConnections.map(({ id }) => id),
    verifiedConnections,
    blockedProviders: [...new Set(knownProviders)]
      .filter((provider) => !selectedAccounts.has(provider))
      .sort(),
    nativeModelAllowlist: [...enabledModels],
    catalog: enabledModels.map((model) => selectedModels.get(model)!),
    providers: [],
  };
}
