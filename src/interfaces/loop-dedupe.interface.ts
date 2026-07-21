export const ILoopDedupeInterface = 'ILoopDedupeRepository';

export type LoopDedupeResponse = {
  similarity: number;
  number: number;
  item_type: 'issue' | 'discussion';
  title: string;
  state: 'closed' | 'open';
  state_reason: 'completed' | 'not_planned' | 'reopened' | 'resolved' | 'outdated' | null;
};

export interface ILoopDedupeInterface {
  getForText(text: string): Promise<LoopDedupeResponse[]>;
}
