/**
 * Client-side mirror of the chat attachment limits enforced by the server.
 * Keep this module free of React and browser-only APIs so the validation stays
 * unit-testable and reusable by the composer and the upload orchestration.
 */

export const MAX_CHAT_ATTACHMENTS = 4;
export const MAX_CHAT_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export const CHAT_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Executable web content is refused before it ever reaches the API. */
export const CHAT_REFUSED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
] as const;

export type ChatAttachmentState = 'UPLOADING' | 'SCANNING' | 'READY' | 'FAILED';

export interface ChatAttachmentDraft {
  readonly localId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly mediaType: 'IMAGE' | 'FILE';
  readonly state: ChatAttachmentState;
  /** Upload progress in whole percents, 0..100. */
  readonly progress: number;
  readonly mediaId?: string;
  readonly errorMessage?: string;
}

export type ChatAttachmentRejectionReason = 'COUNT' | 'SIZE' | 'EMPTY' | 'UNSAFE_TYPE';

export interface ChatAttachmentRejection {
  readonly fileName: string;
  readonly reason: ChatAttachmentRejectionReason;
}

export interface ChatAttachmentSelection {
  readonly accepted: readonly File[];
  readonly rejections: readonly ChatAttachmentRejection[];
}

export function normalizeAttachmentContentType(contentType: string | undefined): string {
  const normalized = (contentType ?? '').trim().toLowerCase();
  return normalized.length > 0 ? normalized : 'application/octet-stream';
}

export function attachmentMediaType(contentType: string): 'IMAGE' | 'FILE' {
  return (CHAT_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType) ? 'IMAGE' : 'FILE';
}

export function normalizeAttachmentFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/u).filter(Boolean).pop()?.trim() ?? '';
  return base.length > 0 ? base : 'файл';
}

export function validateChatAttachmentSelection(
  existingCount: number,
  files: readonly File[],
): ChatAttachmentSelection {
  const accepted: File[] = [];
  const rejections: ChatAttachmentRejection[] = [];
  for (const file of files) {
    if (existingCount + accepted.length >= MAX_CHAT_ATTACHMENTS) {
      rejections.push({ fileName: file.name, reason: 'COUNT' });
      continue;
    }
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      rejections.push({ fileName: file.name, reason: 'SIZE' });
      continue;
    }
    if (file.size <= 0) {
      rejections.push({ fileName: file.name, reason: 'EMPTY' });
      continue;
    }
    const contentType = normalizeAttachmentContentType(file.type);
    if ((CHAT_REFUSED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      rejections.push({ fileName: file.name, reason: 'UNSAFE_TYPE' });
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejections };
}

function rejectionReasonText(reason: ChatAttachmentRejectionReason): string {
  if (reason === 'SIZE') return 'файл больше 15 МБ';
  if (reason === 'EMPTY') return 'файл пустой';
  if (reason === 'UNSAFE_TYPE') return 'такой тип файла нельзя отправить в чате';
  return 'можно прикрепить не более 4 файлов';
}

export function describeChatAttachmentRejections(
  rejections: readonly ChatAttachmentRejection[],
): string | null {
  if (rejections.length === 0) return null;
  const hasCountRejection = rejections.some((rejection) => rejection.reason === 'COUNT');
  const parts: string[] = hasCountRejection ? ['Можно прикрепить не более 4 файлов.'] : [];
  for (const rejection of rejections) {
    if (rejection.reason === 'COUNT') continue;
    parts.push(`«${rejection.fileName}»: ${rejectionReasonText(rejection.reason)}.`);
  }
  return parts.join(' ');
}

export function formatAttachmentSize(byteSize: number): string {
  if (!Number.isFinite(byteSize) || byteSize <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'] as const;
  let value = byteSize;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded).replace('.', ',')} ${units[unitIndex]}`;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
