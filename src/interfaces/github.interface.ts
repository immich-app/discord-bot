export const IGithubInterface = 'IGithubRepository';

export interface SearchOptions {
  query: string;
  per_page?: number;
  page: number;
  sort: 'updated';
  order: 'desc' | 'asc';
}

export interface SearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{
    number: number;
    title: string;
    pull_request: boolean;
  }>;
}

export interface IGithubInterface {
  getIssueOrPr(id: string): Promise<string | undefined>;
  getDiscussion(id: string): Promise<string | undefined>;
  getForkCount(): Promise<number>;
  getStarCount(): Promise<number>;
  search(options: SearchOptions): Promise<SearchResult>;
}
