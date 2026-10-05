import { lookup, LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import Parser from 'rss-parser';
import { IRSSInterface, PostItem } from 'src/interfaces/rss.interface';
import { Agent, buildConnector, fetch } from 'undici';

const parser = new Parser();

const TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 5_000_000;

/** Loopback, private, link-local, shared, documentation, multicast and reserved ranges. */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

/** Kept apart: `BlockList` takes every IPv4 address as inside the IPv4-mapped IPv6 range. */
const MAPPED = new BlockList();
MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6');

/** An IPv4-mapped IPv6 address is judged by its IPv4 address, and refused when it is not written dotted. */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  if (family === 6 && MAPPED.check(address, 'ipv6')) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    return mapped !== undefined && isPublicAddress(mapped);
  }
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

export class FeedAddressError extends Error {
  constructor(hostname: string) {
    super(`${hostname} is not a public address, so its feed is not fetched`);
  }
}

/**
 * Every connection, a redirect's included, is checked where it is made: a hostname by every address it resolves to,
 * an IP literal (which Node connects to without a lookup) as it is, so DNS cannot point a feed into the bot's network.
 */
const guardedDispatcher = (isAllowed: (address: string) => boolean) => {
  const connector = buildConnector({
    lookup: (hostname, options, callback) =>
      lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
        if (error) {
          callback(error, '', 0);
          return;
        }
        if (addresses.length === 0 || addresses.some(({ address }) => !isAllowed(address))) {
          callback(new FeedAddressError(hostname), '', 0);
          return;
        }
        if (options.all) {
          (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
          return;
        }
        callback(null, addresses[0].address, addresses[0].family);
      }),
  });
  return new Agent({
    connect: (options, callback) => {
      const hostname = options.hostname.replace(/^\[|\]$/g, '');
      if (isIP(hostname) && !isAllowed(hostname)) {
        callback(new FeedAddressError(hostname), null);
        return;
      }
      connector(options, callback);
    },
  });
};

const readCapped = async (response: Awaited<ReturnType<typeof fetch>>) => {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > MAX_FEED_BYTES) {
      await reader.cancel();
      throw new Error(`The feed is larger than ${MAX_FEED_BYTES} bytes`);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export class RSSRepository implements IRSSInterface {
  private dispatcher: Agent;

  constructor(isAllowed: (address: string) => boolean = isPublicAddress) {
    this.dispatcher = guardedDispatcher(isAllowed);
  }

  async getFeed(url: string, lastId: string | null) {
    const { protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`${protocol} feeds are not fetched, only http and https ones`);
    }
    const response = await fetch(url, { dispatcher: this.dispatcher, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The feed answered ${response.status}`);
    }
    const feed = await parser.parseString(await readCapped(response));
    const result: PostItem[] = [];

    for (const { guid, title, summary, link, pubDate, content, contentSnippet } of feed.items) {
      if (!guid) {
        continue;
      }

      if (lastId && guid === lastId) {
        return { feed: { profileImageUrl: feed.image?.url, title: feed.title }, posts: result };
      }

      result.push({ id: guid, title, summary: contentSnippet || summary || content, link, pubDate });
    }

    return { feed: { profileImageUrl: feed.image?.url, title: feed.title }, posts: result };
  }
}
