import { getConfig } from 'src/config';
import { Constants } from 'src/constants';
import {
  DocumentCreateResponse,
  DocumentResponse,
  DocumentSearchRequest,
  DocumentShareResponse,
  IOutlineInterface,
} from 'src/interfaces/outline.interface';

export class OutlineRepository implements IOutlineInterface {
  private apiKey: string;
  private headers: HeadersInit;

  constructor() {
    const { outline } = getConfig();
    this.apiKey = outline.apiKey;
    this.headers = { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
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
      headers: this.headers,
      body: JSON.stringify({ id, text, append: true }),
      method: 'POST',
    });
  }

  async shareDocument(documentId: string): Promise<DocumentShareResponse> {
    const response = await fetch(`${Constants.Urls.Outline}/api/shares.create`, {
      headers: this.headers,
      body: JSON.stringify({ documentId, type: 'document', published: true }),
      method: 'POST',
    });

    const json = await response.json();
    return json.data;
  }

  async searchDocuments(dto: DocumentSearchRequest): Promise<DocumentResponse[]> {
    const documents: DocumentResponse[] = [];
    const filters = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => ({ field, operator: 'eq', value }));

    const limit = 50;
    let offset = 0;
    while (true) {
      const response = await fetch(`${Constants.Urls.Outline}/api/documents.list`, {
        headers: this.headers,
        body: JSON.stringify({ filters: [{ operator: 'AND', filters }], limit, offset }),
        method: 'POST',
      });

      const json = await response.json();
      documents.push(...json.data);

      if (!Number.isSafeInteger(json.pagination.total) || json.pagination.total <= limit + offset) {
        break;
      }

      offset += limit;
    }
    return documents;
  }
}
