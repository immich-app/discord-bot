export const IOutlineInterface = 'IOutlineRepository';

export type DocumentCreateResponse = {
  url: string;
};

export interface IOutlineInterface {
  createDocument(options: {
    title: string;
    text?: string;
    collectionId: string;
    parentDocumentId?: string;
    apiKey: string;
    icon?: string;
    iconColor?: string;
  }): Promise<DocumentCreateResponse>;
  addToDocument(options: { id: string; text: string; apiKey: string }): Promise<void>;
}
