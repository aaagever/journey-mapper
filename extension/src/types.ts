export interface JourneyStep {
  id: string;
  stepNumber: number;
  imageDataUrl: string;
  pageUrl: string;
  pageTitle: string;
  timestamp: number;
  label: string;
  parentId?: string | null;
}

export interface JourneySession {
  steps: JourneyStep[];
  createdAt: number;
}

export interface ServerStatus {
  online: boolean;
  figmaConnected: boolean;
}

export interface UploadResponse {
  id: string;
  url: string;
}

export interface ExportRequest {
  steps: Array<{
    id: string;
    stepNumber: number;
    imageUrl: string;
    pageUrl: string;
    pageTitle: string;
    label: string;
    parentId?: string | null;
  }>;
}
