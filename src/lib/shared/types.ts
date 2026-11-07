export interface UserDto {
  id: string;
  email: string;
  displayName: string | null;
  storageUsedBytes: number;
  storageLimitBytes: number;
  createdAt: string;
}

export interface FolderDto {
  id: string;
  parentId: string | null;
  name: string;
  color: string | null;
  createdAt: string;
}

export interface FileDto {
  id: string;
  folderId: string | null;
  fileName: string;
  fileSizeBytes: number;
  storedBytes: number;
  mimeType: string;
  isFavorite: boolean;
  encryption: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  createdAt: string;
  downloadUrl: string;
  thumbnailUrl: string | null;
}

export interface VaultListing {
  folder: FolderDto | null;
  breadcrumbs: { id: string; name: string }[];
  folders: FolderDto[];
  files: FileDto[];
  user: UserDto;
  stats: {
    totalFiles: number;
    totalFolders: number;
    photos: number;
    videos: number;
  };
}

export interface InitUploadResponse {
  uploadId: string;
  storageKey: string;
  partSize: number;
  totalParts: number;
  mode: "single" | "multipart";
  putUrl: string | null;
  partUrls: string[];
}

export interface UploadProgressState {
  id: string;
  fileName: string;
  size: number;
  uploaded: number;
  status: "queued" | "encrypting" | "uploading" | "paused" | "done" | "failed";
  speed: number;
  error?: string;
}
