import type { Client4, WebSocketEvents, WebSocketMessage } from '@mattermost/client';

export const IMattermostInterface = 'IMattermostInterface';

export type MattermostEvents = WebSocketEvents;
export type MattermostEventListener<T extends MattermostEvents> = (msg: WebSocketMessage & { event: T }) => unknown;
export type MattermostEventMessage<T extends MattermostEvents> = WebSocketMessage & {
  event: T;
};
export type Post = Awaited<ReturnType<Client4['createPost']>>;
export type Command = Awaited<ReturnType<Client4['addCommand']>>;
export type CommandWebhookRequest<T extends CommandParameters> = {
  channel_id: string;
  channel_name: string;
  command: string;
  team_domain: string;
  team_id: string;
  text: string;
  token: string;
  trigger_id: string;
  user_id: string;
  user_name: string;
} & {
  parameters: {
    [K in T[number]['name']]:
      | ((T[number] & { name: K })['optional'] extends true ? undefined : unknown)
      | (T[number] & { name: K })['type'] extends 'number'
      ? number
      : string;
  };
};

type DateConfig = {
  min_date?: Date | string;
  max_date?: Date | string;
};
type DatetimeConfig = DateConfig & {
  time_interval?: number;
  location_timezone?: string;
  manual_time_entry?: boolean;
};

type DialogBaseField = {
  /* max length 24 */
  display_name: string;
  name: string;
  optional?: boolean;
  help_text?: string;
  default?: string;
  placeholder?: string;
};
type TextBaseField = DialogBaseField & {
  subtype?: 'text' | 'email' | 'number' | 'password' | 'tel' | 'url';
  min_length?: number;
  max_length?: boolean;
};
type DialogTextField = TextBaseField & { type: 'text' };
type DialogTextareaField = TextBaseField & { type: 'textarea' };
type DialogSelectField = DialogBaseField & { type: 'select'; multiselect?: boolean; refresh?: boolean } & (
    | { data_source: 'users' | 'channels' }
    | { data_source: 'dynamic'; data_source_url: `https://${string}/plugins/${string}` }
    | { data_source?: undefined; options: Array<{ text: string; value: string }> }
  );
type DialogCheckboxField = DialogBaseField & { type: 'bool' };
type DialogRadioField = Omit<DialogBaseField, 'placeholder' | 'optional'> & {
  type: 'radio';
  options: Array<{ text: string; value: string }>;
};
type DialogDateField = DialogBaseField & {
  type: 'date';
  datetime_config: DateConfig;
};
type DialogDatetimeField = DialogBaseField & {
  type: 'datetime';
  datetime_config: DatetimeConfig;
};
type DialogFileField = DialogBaseField & { type: 'file'; allow_multiple?: boolean };
type DialogActionButtonField = {
  display_name: string;
  name: string;
  type: 'action_button';
  action_button: { url: string; context?: Record<string, unknown> };
};

type DialogField =
  | DialogTextField
  | DialogTextareaField
  | DialogSelectField
  | DialogCheckboxField
  | DialogRadioField
  | DialogDateField
  | DialogDatetimeField
  | DialogFileField
  | DialogActionButtonField;

export type Dialog = {
  /* max length 24 */
  title: string;
  introduction_text?: string;
  elements: Array<DialogField>;
  icon_url?: string;
  submit_label?: string;
  notify_on_cancel?: boolean;
  state?: string;
  source_url?: string;
};
export type DialogResponse = {
  type: 'dialog_submission';
  callback_id: string;
  state: string;
  user_id: string;
  channel_id: string;
  team_id: string;
  submission: Record<string, string>;
  file_ids?: string[];
  cancelled: boolean;
};
type ResponseType<T extends Dialog, K> = (T['elements'][number] & { name: K })['type'] extends 'bool'
  ? boolean
  : string;
export type DialogData<T extends Dialog> =
  | { cancelled: true }
  | ({ cancelled: false } & {
      [name in Exclude<T['elements'][number], { type: 'file' } | { optional: true }>['name']]: ResponseType<T, name>;
    } & {
      [name in Exclude<T['elements'][number], { type: 'file' }>['name']]?: ResponseType<T, name>;
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    } & ('file' extends Exclude<T['elements'][number], { optional: true }>['type'] ? { file_ids: string[] } : {}) &
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      ('file' extends T['elements'][number]['type'] ? { file_ids?: string[] } : {}));

type ParameterType = 'text' | 'userMention' | 'channelMention' | 'number';
export type CommandParameters = Array<{ name: string; type: ParameterType; optional: boolean }>;
type RequiredProps = 'display_name' | 'description' | 'trigger' | 'team_id';
export type CommandCreate<T extends CommandParameters> = Pick<Command, RequiredProps> &
  Partial<Omit<Command, RequiredProps | 'id' | 'req' | 'method' | 'url' | 'auto_complete_hint'>> & { parameters?: T };
export type UserProfile = Awaited<ReturnType<Client4['getMe']>>;

export interface IMattermostInterface {
  init: () => Promise<void>;
  registerEventListener: <T extends MattermostEvents>(event: T, listener: MattermostEventListener<T>) => void;
  send: (post: { channelId: string; message: string; props?: Record<string, unknown> }) => Promise<void>;
  reply: (reply: { channelId: string; rootId: string; message: string }) => Promise<void>;
  updatePost: (post: Partial<Post> & { id: string }) => Promise<void>;
  createEmote: (name: string, emoteUrl: string) => Promise<void>;
  streamChannels: (
    teamId?: string,
  ) => AsyncGenerator<Awaited<ReturnType<Client4['getAllChannels']>>['channels'][number]>;
  joinChannel: (channelId: string) => Promise<void>;
  registerCommand: <const T extends CommandParameters = never>(
    command: CommandCreate<T>,
    handler: (data: CommandWebhookRequest<T>) => unknown,
  ) => Promise<void>;
  runCommand: (id: string, data: CommandWebhookRequest<never>) => Promise<unknown>;
  openDialog: <const T extends Dialog>(triggerId: string, dialog: T) => Promise<DialogData<T>>;
  submitDialog: (dto: DialogResponse, slug: string) => void;
}
