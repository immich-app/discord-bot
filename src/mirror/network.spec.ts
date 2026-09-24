import { isConnectFailure, isTransientDatabaseFailure, isUniqueViolation } from 'src/mirror/network';
import { describe, expect, it } from 'vitest';

const withCode = (code: string, error: Error = new Error(code)) => Object.assign(error, { code });

describe('isConnectFailure', () => {
  it.each([
    ['a refused connection', withCode('ECONNREFUSED')],
    ['every address refusing', withCode('ECONNREFUSED', new AggregateError([]))],
    ['an unknown host', withCode('ENOTFOUND')],
    ['a failed lookup', withCode('EAI_AGAIN')],
    ['an unreachable network', withCode('ENETUNREACH')],
    ['an unreachable host', withCode('EHOSTUNREACH')],
    ['a connect timeout', withCode('UND_ERR_CONNECT_TIMEOUT')],
    ['a fetch that could not connect', new TypeError('fetch failed', { cause: withCode('ECONNREFUSED') })],
  ])('should count %s', (_, error) => {
    expect(isConnectFailure(error)).toBe(true);
  });

  it.each([
    ['a reset connection', withCode('ECONNRESET')],
    ['a closed socket', withCode('UND_ERR_SOCKET')],
    ['a fetch that lost its connection', new TypeError('fetch failed', { cause: withCode('UND_ERR_SOCKET') })],
    ['a fetch without a reason', new TypeError('fetch failed')],
    ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
    ['something that is no error', { code: 'ECONNREFUSED' }],
  ])('should not count %s', (_, error) => {
    expect(isConnectFailure(error)).toBe(false);
  });
});

describe('isTransientDatabaseFailure', () => {
  it.each([
    ['a refused connection', withCode('ECONNREFUSED')],
    ['a reset connection', withCode('ECONNRESET')],
    ['a timed out connection', withCode('ETIMEDOUT')],
    ['a connection exception', withCode('08006')],
    ['too many connections', withCode('53300')],
    ['an administrator shutdown', withCode('57P01')],
    ['a server starting up', withCode('57P03')],
    ['a serialization failure', withCode('40001')],
    ['a deadlock', withCode('40P01')],
    ['a connection lost mid-query', new Error('Connection terminated unexpectedly')],
    ['a pool that could not connect', new Error('timeout exceeded when trying to connect')],
    [
      'a client broken by an earlier error',
      new Error('Client has encountered a connection error and is not queryable'),
    ],
  ])('should count %s', (_, error) => {
    expect(isTransientDatabaseFailure(error)).toBe(true);
  });

  it.each([
    ['a unique violation', withCode('23505')],
    ['a foreign key violation', withCode('23503')],
    ['a syntax error', withCode('42601')],
    ['a query canceled by statement timeout', withCode('57014')],
    ['an unrelated error', new Error('boom')],
    ['something that is no error', { code: '08006' }],
  ])('should not count %s', (_, error) => {
    expect(isTransientDatabaseFailure(error)).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('should count only a unique violation', () => {
    expect(
      [withCode('23505'), withCode('23503'), new Error('23505'), { code: '23505' }].map(isUniqueViolation),
    ).toEqual([true, false, false, false]);
  });
});
