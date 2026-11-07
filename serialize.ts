import type { Folder, FileRow, User } from "@/db/schema";
import { storage } from "./storage";
import type { FileDto, FolderDto, UserDto } from "@/lib/shared/types";

export function publicUser(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    storageUsedBytes: Number(user.storageUsedBytes),
    storageLimitBytes: Number(user.storageLimitBytes),
    createdAt: user.createdAt.toISOString(),
  };
}

export function serializeFolder(folder: Folder): FolderDto {
  return {
    id: folder.id,
    parentId: folder.parentId,
    name: folder.name,
    color: folder.color,
    createdAt: folder.createdAt.toISOString(),
  };
}

export function serializeFile(file: FileRow): FileDto {
  const driver = storage();
  return {
    id: file.id,
    folderId: file.folderId,
    fileName: file.fileName,
    fileSizeBytes: Number(file.fileSizeBytes),
    storedBytes: Number(file.storedBytes),
    mimeType: file.mimeType,
    isFavorite: file.isFavorite,
    encryption: file.encryption,
    width: file.width,
    height: file.height,
    durationSeconds: file.durationSeconds,
    createdAt: file.createdAt.toISOString(),
    downloadUrl: driver.presignGet(file.s3StorageKey, 3600),
    thumbnailUrl: file.thumbnailKey ? driver.presignGet(file.thumbnailKey, 3600) : null,
  };
}
