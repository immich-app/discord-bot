import { Logger } from '@nestjs/common';
import { getConfig } from 'src/config';
import { Constants } from 'src/constants';
import { GitlabItem, GitlabItemKind, IGitlabInterface } from 'src/interfaces/gitlab.interface';

const TIMEOUT_MS = 10_000;

/** A file is read for at most a 20-line snippet, so a larger one is not worth holding in memory. */
const MAX_FILE_BYTES = 1_000_000;

const GROUP_PAGE_SIZE = 100;

/** A group with more than this many pages of projects is read only that far. */
const MAX_GROUP_PAGES = 20;

/** GitLab answers 404 for what a token cannot see, and 401 or 403 for what needs one. */
const NOT_VISIBLE = new Set([401, 403, 404]);

class GitlabError extends Error {
  constructor(
    public status: number,
    path: string,
  ) {
    super(`GitLab answered ${status} for ${path}`);
  }
}

/** `undefined` once the body passes `limit` bytes, read no further. */
const readCapped = async (response: Response, limit: number) => {
  if (Number(response.headers.get('content-length')) > limit || !response.body) {
    await response.body?.cancel();
    return;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return;
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export class GitlabRepository implements IGitlabInterface {
  private logger = new Logger(GitlabRepository.name);
  private headers: Record<string, string>;

  constructor() {
    const { gitlab } = getConfig();
    this.headers = gitlab.token ? { 'PRIVATE-TOKEN': gitlab.token } : {};
  }

  async getProjectPath(path: string) {
    const project = await this.request<{ path_with_namespace: string }>(`/projects/${encodeURIComponent(path)}`);
    return project?.path_with_namespace;
  }

  async getGroupProjects(path: string) {
    const group = await this.request<{ id: number; full_path: string }>(`/groups/${encodeURIComponent(path)}`);
    if (!group) {
      return;
    }
    const projects: string[] = [];
    for (let page = 1; page <= MAX_GROUP_PAGES; page++) {
      const batch = await this.request<{ path_with_namespace: string }[]>(
        `/groups/${group.id}/projects?include_subgroups=true&simple=true&order_by=path&sort=asc&per_page=${GROUP_PAGE_SIZE}&page=${page}`,
      );
      if (!batch) {
        throw new Error(`GitLab did not show page ${page} of the projects of group ${group.full_path}`);
      }
      projects.push(...batch.map(({ path_with_namespace }) => path_with_namespace));
      if (batch.length < GROUP_PAGE_SIZE) {
        break;
      }
    }
    return { path: group.full_path, projects };
  }

  async getItem(path: string, kind: GitlabItemKind, iid: number): Promise<GitlabItem | undefined> {
    try {
      const item = await this.request<{ title: string; web_url: string; updated_at: string }>(
        `/projects/${encodeURIComponent(path)}/${kind}/${iid}`,
      );
      return item && { kind, title: item.title, url: item.web_url, updatedAt: new Date(item.updated_at) };
    } catch (error) {
      this.logger.warn(`Could not fetch GitLab ${kind} ${iid} of ${path}`, error);
    }
  }

  async getFileContent(path: string, ref: string, file: string) {
    try {
      const text = await this.request(
        `/projects/${encodeURIComponent(path)}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`,
        'text',
      );
      return text?.split('\n');
    } catch (error) {
      this.logger.warn(`Could not fetch a GitLab file of ${path}`, error);
    }
  }

  private async request<T>(path: string): Promise<T | undefined>;
  private async request(path: string, as: 'text'): Promise<string | undefined>;
  private async request(path: string, as: 'json' | 'text' = 'json') {
    const response = await fetch(`https://${Constants.Gitlab.Host}/api/v4${path}`, {
      headers: this.headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (NOT_VISIBLE.has(response.status)) {
      return;
    }
    if (!response.ok) {
      throw new GitlabError(response.status, path);
    }
    return as === 'text' ? readCapped(response, MAX_FILE_BYTES) : response.json();
  }
}
