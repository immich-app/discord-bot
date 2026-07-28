import { getConfig } from 'src/config';
import { Constants } from 'src/constants';
import { DocumentCreateResponse, DocumentShareResponse, IOutlineInterface } from 'src/interfaces/outline.interface';

export class OutlineRepository implements IOutlineInterface {
  private apiKey: string;

  constructor() {
    const { outline } = getConfig();
    this.apiKey = outline.apiKey;
  }

  async createDocument({
    title,
    text,
    collectionId,
    parentDocumentId,
    icon,
    iconColor: color,
  }: {
    title: string;
    text?: string;
    collectionId: string;
    parentDocumentId?: string;
    icon?: string;
    iconColor?: string;
  }): Promise<DocumentCreateResponse> {
    const response = await fetch(`${Constants.Urls.Outline}/api/documents.create`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, collectionId, parentDocumentId, text, publish: true, icon, color }),
      method: 'POST',
    });
    const json = await response.json();
    return json.data;
  }

  async addToDocument({ id, text }: { id: string; text: string }): Promise<void> {
    await fetch(`${Constants.Urls.Outline}/api/documents.update`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, text, append: true }),
      method: 'POST',
    });
  }

  async shareDocument(documentId: string): Promise<DocumentShareResponse> {
    const response = await fetch(`${Constants.Urls.Outline}/api/shares.create`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId, type: 'document', published: true }),
      method: 'POST',
    });

    const json = await response.json();
    return json.data;
  }
}
