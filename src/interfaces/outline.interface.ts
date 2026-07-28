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
}
