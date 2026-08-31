export const IOutlineInterface = 'IOutlineRepository';

export type DocumentCreateResponse = {
  id: string;
  parentDocumentId: string | null;
  url: string;
};

export type DocumentShareResponse = {
  url: string;
  allowSubscriptions: boolean;
  allowIndexing: boolean;
  showLastUpdated: boolean;
  showTOC: boolean;
};

export type DocumentResponse = {
  id: string;
  url: string;
  title: string;
  collectionId: string;
  parentDocumentId: string;
};

export type DocumentSearchRequest = {
  createdAt?: Date;
  updatedAt?: Date;
  publishedAt?: Date;
  archivedAt?: Date;
  title?: string;
  templateId?: string;
  collectionId?: string;
  userId?: string;
  documentId?: string;
  parentDocumentId?: string;
};

export interface IOutlineInterface {
  createDocument(options: {
    title: string;
    text?: string;
    collectionId: string;
    parentDocumentId?: string;
    icon?: string;
    iconColor?: string;
  }): Promise<DocumentCreateResponse>;
  addToDocument(options: { id: string; text: string }): Promise<void>;
  shareDocument(id: string): Promise<DocumentShareResponse>;
  searchDocuments(dto: DocumentSearchRequest): Promise<DocumentResponse[]>;
}
