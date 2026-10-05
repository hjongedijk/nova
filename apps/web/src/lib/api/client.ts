/** All calls to the NOVA API go through here; components never call fetch themselves. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: string[],
    readonly pinRequired = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function parse<T>(response: Response, path: string): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    details?: string[];
    pinRequired?: boolean;
  };
  if (!response.ok)
    throw new ApiError(
      data.error || `${path}: HTTP ${response.status}`,
      response.status,
      data.details,
      data.pinRequired === true,
    );
  return data as T;
}

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  return parse<T>(
    await fetch(`/api${path}`, { cache: "no-store", ...init }),
    path,
  );
}

export async function sendJson<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  return parse<T>(
    await fetch(`/api${path}`, {
      method,
      cache: "no-store",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    path,
  );
}
