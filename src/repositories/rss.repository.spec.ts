import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FeedAddressError, isPublicAddress, RSSRepository } from 'src/repositories/rss.repository';
import { afterEach, describe, expect, it, vitest } from 'vitest';

/** Hostnames under `.test` resolve to the addresses given here; every other one as the system resolves it. */
const answers = vitest.hoisted(() => new Map<string, string[]>());

vitest.mock('node:dns', async (importOriginal) => {
  const dns = await importOriginal<typeof import('node:dns')>();
  return {
    ...dns,
    lookup: ((hostname: string, options: object, callback: (...args: unknown[]) => void) => {
      const addresses = answers.get(hostname);
      if (!addresses) {
        return dns.lookup(hostname, options, callback as never);
      }
      callback(
        null,
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
    }) as typeof dns.lookup,
  };
});

const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>News</title>
<item><guid>3</guid><title>Third</title><description>three</description></item>
<item><guid>2</guid><title>Second</title><description>two</description></item>
<item><guid>1</guid><title>First</title><description>one</description></item>
</channel></rss>`;

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('should take %s as public', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:a00:1',
    '::ffff:808:808',
    'not an address',
  ])('should not take %s as public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe(RSSRepository.name, () => {
  const servers: Server[] = [];

  const serve = async (handler: Parameters<typeof createServer>[1], host = '127.0.0.1') => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    return (server.address() as AddressInfo).port;
  };

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  describe('getFeed', () => {
    it('should parse a feed, newest first, up to the last post it saw', async () => {
      const port = await serve((_, response) => response.end(FEED));
      const sut = new RSSRepository(() => true);

      const { feed, posts } = await sut.getFeed(`http://127.0.0.1:${port}/feed`, '1');

      expect(feed.title).toBe('News');
      expect(posts.map(({ id, title, summary }) => ({ id, title, summary }))).toEqual([
        { id: '3', title: 'Third', summary: 'three' },
        { id: '2', title: 'Second', summary: 'two' },
      ]);
    });

    it.each(['127.0.0.1', 'localhost'])('should refuse a feed on %s, before any request', async (host) => {
      let requests = 0;
      const port = await serve((_, response) => {
        requests++;
        response.end(FEED);
      });

      await expect(new RSSRepository().getFeed(`http://${host}:${port}/feed`, null)).rejects.toThrow(
        expect.objectContaining({ cause: expect.any(FeedAddressError) }),
      );
      expect(requests).toBe(0);
    });

    describe('a hostname', () => {
      afterEach(() => answers.clear());

      const onlyLoopback = (address: string) => address === '127.0.0.1';

      it('should be fetched when every address it resolves to is allowed', async () => {
        answers.set('feed.test', ['127.0.0.1']);
        const port = await serve((_, response) => response.end(FEED));

        const { posts } = await new RSSRepository(onlyLoopback).getFeed(`http://feed.test:${port}/feed`, null);

        expect(posts).toHaveLength(3);
      });

      it.each([
        ['an address that is not allowed', ['10.0.0.1']],
        ['an allowed and a disallowed address', ['127.0.0.1', '10.0.0.1']],
        ['a disallowed IPv6 address beside an allowed one', ['127.0.0.1', 'fd00::1']],
        ['no address at all', []],
      ])('should be refused when it resolves to %s, before any request', async (_, addresses) => {
        answers.set('feed.test', addresses);
        let requests = 0;
        const port = await serve((_, response) => {
          requests++;
          response.end(FEED);
        });

        await expect(new RSSRepository(onlyLoopback).getFeed(`http://feed.test:${port}/feed`, null)).rejects.toThrow(
          expect.objectContaining({ cause: expect.any(FeedAddressError) }),
        );
        expect(requests).toBe(0);
      });

      it('should be refused as the target of a redirect when it resolves to an address that is not allowed', async () => {
        answers.set('inside.test', ['10.0.0.1']);
        const port = await serve((_, response) => {
          response.writeHead(302, { location: 'http://inside.test/feed' }).end();
        });

        await expect(new RSSRepository(onlyLoopback).getFeed(`http://127.0.0.1:${port}/feed`, null)).rejects.toThrow(
          expect.objectContaining({ cause: expect.any(FeedAddressError) }),
        );
      });
    });

    it('should refuse a redirect to an address that is not allowed', async () => {
      let reached = 0;
      const target = await serve((_, response) => {
        reached++;
        response.end(FEED);
      }, '127.0.0.2');
      const port = await serve((_, response) => {
        response.writeHead(302, { location: `http://127.0.0.2:${target}/feed` }).end();
      });
      const sut = new RSSRepository((address) => address === '127.0.0.1');

      await expect(sut.getFeed(`http://127.0.0.1:${port}/feed`, null)).rejects.toThrow();
      expect(reached).toBe(0);
    });

    it.each(['file:///etc/passwd', 'ftp://example.com/feed', 'gopher://example.com/'])(
      'should refuse the URL %s',
      async (url) => {
        await expect(new RSSRepository(() => true).getFeed(url, null)).rejects.toThrow(
          'feeds are not fetched, only http and https ones',
        );
      },
    );

    it('should refuse a feed larger than 5 MB', async () => {
      const port = await serve((_, response) => response.end('x'.repeat(5_000_001)));

      await expect(new RSSRepository(() => true).getFeed(`http://127.0.0.1:${port}/feed`, null)).rejects.toThrow(
        'The feed is larger than 5000000 bytes',
      );
    });

    it('should refuse an error status', async () => {
      const port = await serve((_, response) => response.writeHead(404).end());

      await expect(new RSSRepository(() => true).getFeed(`http://127.0.0.1:${port}/feed`, null)).rejects.toThrow(
        'The feed answered 404',
      );
    });
  });
});
