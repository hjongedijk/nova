import type { HealthResponse } from "@nova/contracts";
import { getJson } from "./client.ts";

export const getHealth = () => getJson<HealthResponse>("/health");
