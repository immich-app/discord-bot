import { isConnectFailure } from 'src/mirror/network';
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
