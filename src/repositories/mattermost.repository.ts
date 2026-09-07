import { Client4, WebSocketClient } from '@mattermost/client';
import { getConfig } from 'src/config';
import {
  Command,
  CommandCreate,
  CommandParameters,
  CommandWebhookRequest,
  Dialog,
  DialogData,
  DialogResponse,
  IMattermostInterface,
  MattermostEvents,
  Post,
  UserProfile,
  type MattermostEventListener,
} from 'src/interfaces/mattermost.interface';
import WebSocket from 'ws';

export class MattermostRepository implements IMattermostInterface {
  #client: Client4;
  #wsClient: WebSocketClient;
  #user!: UserProfile;
  #eventListeners: Partial<{ [K in MattermostEvents]: MattermostEventListener<K>[] }> = {};
  #commandHandlers: Record<
    string,
    { parameters?: CommandParameters; handler: (data: CommandWebhookRequest<never>) => unknown }
  > = {};
  #modalHandlers: Record<string, (data: DialogResponse) => void> = {};

  constructor() {
    const { mattermost } = getConfig();

    globalThis.WebSocket = WebSocket as never;
    this.#client = new Client4();
    this.#client.setUrl(mattermost.domain);
    this.#client.setToken(mattermost.botToken);

    const wsClient = new WebSocketClient();
    wsClient.initialize(this.#client.getWebSocketUrl(), mattermost.botToken);
    wsClient.addMissedMessageListener(() => {});
    this.#wsClient = wsClient;
  }

  async init() {
    this.#user = await this.#client.getMe();

    this.#wsClient.addMessageListener(async (msg) => {
      // I have to cast the type safety away since the union type becomes too complex for TS
      const listeners = (this.#eventListeners[msg.event] ?? []) as ((msg: unknown) => unknown)[];
      await Promise.all(listeners.map((listener) => listener(msg)));
    });
    await this.clearCommands();
  }

  registerEventListener<T extends MattermostEvents>(event: T, listener: MattermostEventListener<T>) {
    if (!this.#eventListeners[event]) {
      this.#eventListeners[event] = [];
    }
    this.#eventListeners[event].push(listener);
  }

  #renderCommandParameter({ type, name, optional }: CommandParameters[number]) {
    let parameterName = name;
    switch (type) {
      case 'channelMention': {
        parameterName = `~${parameterName}`;
        break;
      }
      case 'text': {
        parameterName = `'${parameterName}'`;
        break;
      }
      case 'userMention': {
        parameterName = `@${parameterName}`;
        break;
      }
    }

    return optional ? `[${parameterName}]` : parameterName;
  }

  async registerCommand<T extends CommandParameters>(
    { parameters, ...command }: CommandCreate<T>,
    handler: (data: CommandWebhookRequest<T>) => unknown,
  ) {
    const id = crypto.randomUUID();
    this.#commandHandlers[id] = { parameters, handler } as never;

    await this.#client.addCommand({
      method: 'P',
      url: `https://discord-webhooks.immich.cloud/webhooks/mattermost/command/${id}`,
      username: this.#user.first_name,
      icon_url: this.#client.getProfilePictureUrl(this.#user.id, this.#user.last_picture_update),
      auto_complete_hint: parameters
        ? parameters.map((parameter) => this.#renderCommandParameter(parameter)).join(' ')
        : undefined,
      auto_complete_desc: command.description,
      ...command,
    } as Command);
  }

  async clearCommands() {
    const teams = await this.#client.getMyTeams();

    for (const { id } of teams) {
      for (const command of await this.#client.getCustomTeamCommands(id)) {
        if (command.creator_id === this.#user.id) {
          await this.#client.deleteCommand(command.id);
        }
      }
    }
  }

  async runCommand(id: string, data: CommandWebhookRequest<never>) {
    const command = this.#commandHandlers[id];
    if (!command) {
      return;
    }
    const { parameters, handler } = command;

    if (!parameters) {
      return handler(data);
    }

    const args = data.text.match(/(?:[^\s']+|'[^']*'|')+/g) ?? [];

    if (args.length !== parameters.filter(({ optional }) => !optional).length) {
      return { text: 'Insufficient parameters' };
    }

    const parsedParameters: Record<string, unknown> = {};

    let argsIndex = 0;
    for (let i = 0; i < parameters.length; i++) {
      const parameter = parameters[i];
      const arg = args[argsIndex];

      switch (parameter.type) {
        case 'channelMention': {
          if (arg.startsWith('~')) {
            argsIndex++;
            parsedParameters[parameter.name] = arg.slice(1);
            continue;
          }
          break;
        }
        case 'userMention': {
          if (arg.startsWith('@')) {
            argsIndex++;
            parsedParameters[parameter.name] = arg.slice(1);
            continue;
          }
          break;
        }
        case 'text': {
          if (arg.startsWith("'") && arg.endsWith("'")) {
            argsIndex++;
            parsedParameters[parameter.name] = arg.slice(1, -1);
            continue;
          }
          break;
        }
        case 'number': {
          if (Number.isFinite(Number(arg))) {
            argsIndex++;
            parsedParameters[parameter.name] = Number(arg);
            continue;
          }
          break;
        }
      }

      if (parameter.optional) {
        continue;
      }
      return { text: `Parameter ${parameter.name} required but is not provided or invalid` };
    }

    return handler({ ...data, parameters: parsedParameters });
  }

  async send({ channelId, message, props }: { channelId: string; message: string; props?: Record<string, unknown> }) {
    await this.#client.createPost({ channel_id: channelId, message, props });
  }

  async reply({ channelId, rootId, message }: { channelId: string; rootId: string; message: string }) {
    await this.#client.createPost({ channel_id: channelId, root_id: rootId, message });
  }

  async updatePost(post: Partial<Post> & { id: string }) {
    await this.#client.patchPost(post);
  }

  async createEmote(name: string, emoteUrl: string) {
    const emote = await fetch(emoteUrl).then((response) => response.blob());
    await this.#client.createCustomEmoji({ creator_id: this.#user.id, name }, new File([emote], name));
  }

  async *streamChannels(teamId?: string) {
    let totalCount: number | undefined;
    let page = 0;
    const pageSize = 100;

    while (true) {
      const { channels, total_count } = await this.#client.getAllChannels(
        page,
        pageSize,
        undefined,
        true,
        true,
        false,
        true,
        false,
        false,
      );

      for (const channel of channels) {
        if (teamId && channel.team_id === teamId) {
          yield channel;
        }
      }

      if (!Number.isSafeInteger(total_count)) {
        break;
      }

      if (totalCount === undefined) {
        totalCount = total_count;
      }

      if (++page * pageSize >= totalCount) {
        break;
      }
    }
  }

  async joinChannel(channelId: string) {
    await this.#client.addToChannel(this.#user.id, channelId);
  }

  async openDialog<const T extends Dialog>(triggerId: string, dialog: T) {
    const id = crypto.randomUUID();
    const { promise, reject, resolve } = Promise.withResolvers<DialogData<T>>();

    this.#modalHandlers[id] = (response) => {
      if (response.cancelled) {
        resolve({ cancelled: true });
      } else {
        resolve({ ...response.submission, cancelled: false, file_ids: response.file_ids } as DialogData<T>);
      }
    };

    try {
      await fetch(`${this.#client.getUrl()}/api/v4/actions/dialogs/open`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#client.getToken()}` },
        body: JSON.stringify({
          url: `https://discord-webhooks.immich.cloud/webhooks/mattermost/dialog/${id}`,
          trigger_id: triggerId,
          dialog: { ...dialog, notify_on_cancel: true },
        }),
      });
    } catch (error) {
      reject(error);
    }

    return promise;
  }

  submitDialog(dto: DialogResponse, slug: string) {
    this.#modalHandlers[slug](dto);
  }
}
