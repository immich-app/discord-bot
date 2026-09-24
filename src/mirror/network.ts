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

const LOST_CONNECTIONS = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/** Connection exceptions, lack of resources, a server shutting down or starting, serialization failures and deadlocks. */
const TRANSIENT_SQLSTATE = /^(08|53|57P0[1-3]$|40001$|40P01$)/;

/** node-postgres reports a connection lost or never made through these messages alone. */
const LOST_DATABASE = /connection terminated|timeout exceeded when trying to connect|not queryable/i;

const codeOf = (error: Error) => String((error as { code?: unknown }).code);

/** A database failure that may well not happen again, which a write is worth repeating after. */
export const isTransientDatabaseFailure = (error: unknown) =>
  error instanceof Error &&
  (isConnectFailure(error) ||
    LOST_CONNECTIONS.has(codeOf(error)) ||
    TRANSIENT_SQLSTATE.test(codeOf(error)) ||
    LOST_DATABASE.test(error.message));

export const isUniqueViolation = (error: unknown) => error instanceof Error && codeOf(error) === '23505';
