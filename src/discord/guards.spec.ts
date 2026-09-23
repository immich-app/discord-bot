import { Logger } from '@nestjs/common';
import { Client, DIService, Discord, GuardFunction, MetadataStorage, On } from 'discordx';
import { reportErrors } from 'src/discord/guards';
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

describe('reportErrors', () => {
  const client = {} as Client;

  let errorMock: ReturnType<typeof vitest.spyOn>;

  beforeEach(() => {
    errorMock = vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vitest.restoreAllMocks();
  });

  it('should run the handler and report nothing when it succeeds', async () => {
    const onError = vitest.fn().mockResolvedValue(undefined);
    const next = vitest.fn().mockResolvedValue('result');

    await expect(reportErrors(onError)([], client, next, {})).resolves.toBe('result');

    expect(next).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('should hand a thrown error to the error handler once and resolve', async () => {
    const error = new Error('boom');
    const onError = vitest.fn().mockResolvedValue(undefined);

    await expect(reportErrors(onError)([], client, () => Promise.reject(error), {})).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('should log and resolve when the error handler throws', async () => {
    const reportError = new Error('report failed');
    const onError = vitest.fn().mockRejectedValue(reportError);

    await expect(
      reportErrors(onError)([], client, () => Promise.reject(new Error('boom')), {}),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledOnce();
    expect(errorMock).toHaveBeenCalledExactlyOnceWith(
      'Could not report a Discord handler error: Error: boom',
      reportError,
    );
  });
});

describe('reportErrors in the discordx runtime', () => {
  const messageCreate = { eventName: 'messageCreate', isOnce: false, isRest: false };
  const message = { content: 'hello' };

  let client: Client;

  const buildClient = async (guards: GuardFunction[], error: Error) => {
    MetadataStorage.clear();

    @Discord()
    class ThrowingEvents {
      @On({ event: 'messageCreate' })
      onMessageCreate() {
        throw error;
      }
    }

    client = new Client({ intents: [], silent: true, guards });
    await client.build();
    return ThrowingEvents;
  };

  afterEach(async () => {
    client.removeEvents();
    await client.destroy();
    MetadataStorage.clear();
    DIService.engine.clearAllServices();
  });

  it('should hand what an @On handler throws to the error handler', async () => {
    const error = new Error('handler failed');
    const onError = vitest.fn().mockResolvedValue(undefined);
    await buildClient([reportErrors(onError)], error);

    await client.trigger(messageCreate, message);

    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('should report an error from an event the client emits', async () => {
    const error = new Error('handler failed');
    const onError = vitest.fn().mockResolvedValue(undefined);
    await buildClient([reportErrors(onError)], error);

    client.emit('messageCreate', message as never);

    await vitest.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(error));
  });

  it('should lose what an @On handler throws without the guard', async () => {
    const clientError = vitest.fn();
    await buildClient([], new Error('handler failed'));
    client.on('error', clientError);

    await expect(client.trigger(messageCreate, message)).resolves.toEqual([null]);

    expect(clientError).not.toHaveBeenCalled();
  });
});
