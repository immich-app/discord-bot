export const IGitlabInterface = 'IGitlabInterface';

export type GitlabItemKind = 'issues' | 'merge_requests';

export type GitlabItem = { kind: GitlabItemKind; title: string; url: string; updatedAt: Date };

/** Projects are named by their path, `namespace/project`, without the host. */
export interface IGitlabInterface {
  /** The path as GitLab spells it, `undefined` when GitLab knows no such project or the bot cannot see it. */
  getProjectPath(path: string): Promise<string | undefined>;
  /** `undefined` when there is none, the bot cannot see it, or GitLab cannot be reached. */
  getItem(path: string, kind: GitlabItemKind, iid: number): Promise<GitlabItem | undefined>;
  getFileContent(path: string, ref: string, file: string): Promise<string[] | undefined>;
  /**
   * Every project of a group and its subgroups, by path; `undefined` when there is no such group or it cannot be
   * seen. A page of projects it cannot see throws, so a list cut short never passes for the whole.
   */
  getGroupProjects(path: string): Promise<{ path: string; projects: string[] } | undefined>;
}
