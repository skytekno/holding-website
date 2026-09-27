import { z } from "zod";

const errorSchema = z.object({ error: z.string() });

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function request<T>(
  base: string,
  token: string,
  path: string,
  schema: z.ZodType<T>,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    ...options,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    let message = `The request failed (${response.status}). Please try again.`;
    try {
      const payload = errorSchema.safeParse(await response.json());
      if (payload.success) message = payload.data.error;
    } catch {
      /* Keep the safe fallback when the proxy returns a non-JSON error. */
    }
    throw new ApiError(response.status, message);
  }
  let payload: unknown;
  try {
    payload = response.status === 204 ? undefined : await response.json();
  } catch {
    throw new ApiError(response.status, "The content API returned an invalid response. Please try again.");
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(response.status, "The content API returned an invalid response. Please try again.");
  }
  return parsed.data;
}
