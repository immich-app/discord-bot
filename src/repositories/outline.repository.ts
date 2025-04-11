import { Constants } from 'src/constants';
import { DocumentCreateResponse, IOutlineInterface } from 'src/interfaces/outline.interface';

export class OutlineRepository implements IOutlineInterface {
  async createDocument({
    title,
    text,
    collectionId,
    parentDocumentId,
    apiKey,
  }: {
    title: string;
    text?: string;
    collectionId: string;
    parentDocumentId?: string;
    apiKey: string;
  }): Promise<DocumentCreateResponse> {
    const response = await fetch(`${Constants.Urls.Outline}/api/documents.create`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, collectionId, parentDocumentId, text, publish: true }),
      method: 'POST',
    });
    const json = await response.json();
    return json.data;
  }

  async addToDocument({ id, text, apiKey }: { id: string; text: string; apiKey: string }): Promise<void> {
    await fetch(`${Constants.Urls.Outline}/api/documents.update`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text, append: true }),
      method: 'POST',
    });
  }
}
