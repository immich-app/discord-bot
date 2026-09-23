const CONNECT_FAILURES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const hasConnectCode = (error: unknown) =>
  error instanceof Error && CONNECT_FAILURES.has(String((error as { code?: unknown }).code));

/** The request failed before a connection was made, so the server never saw it; `fetch` puts the reason in `cause`. */
export const isConnectFailure = (error: unknown) =>
  hasConnectCode(error) || (error instanceof Error && hasConnectCode(error.cause));
