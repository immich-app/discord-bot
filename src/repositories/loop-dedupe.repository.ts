import { getConfig } from 'src/config';
import { ILoopDedupeInterface, LoopDedupeResponse } from 'src/interfaces/loop-dedupe.interface';

export class LoopDedupeRepository implements ILoopDedupeInterface {
  private apiKey: string;

  constructor() {
    const { loopDedupe } = getConfig();
    this.apiKey = loopDedupe.apiKey;
  }

  async getForText(text: string): Promise<LoopDedupeResponse[]> {
    const response = await fetch('https://loopdedupe.internal.immich.cloud/api/search', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error(`Unable to fetch issues from loopdedupe with status ${response.status}: ${response.statusText}`);
    }

    return (await response.json()).items as Promise<LoopDedupeResponse[]>;
  }
}
