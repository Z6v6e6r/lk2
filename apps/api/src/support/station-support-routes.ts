import type { LocationRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { createHash } from 'node:crypto';

import { sendApiError } from '../http-errors.js';
import type { StationSupportRepository } from './station-support-repository.js';
import {
  StationSupportProviderError,
  normalizeSupportPhoneDigits,
  type StationSupportEventAttachment,
  type StationSupportProvider,
  type StationSupportProviderDialog,
  type StationSupportProviderMessage,
} from './station-support-provider.js';
import {
  STATION_SUPPORT_MEDIA_INLINE_URL_BUDGET_BYTES,
  STATION_SUPPORT_MEDIA_MAX_ATTACHMENTS,
  STATION_SUPPORT_MEDIA_MAX_BYTES,
  STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES,
  STATION_SUPPORT_MEDIA_URL_TTL_SECONDS,
  convertStationSupportWebp,
  isStationSupportImageContentType,
  readStationSupportProviderImage,
  stationSupportAttachmentId,
  stationSupportAttachmentSha256,
  stationSupportMediaObjectKey,
  type StationSupportMediaStore,
} from './station-support-media.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 4_000;
const MESSAGE_PAGE_LIMIT = 50;
const MAX_STATION_DIALOGS = 200;
const MAX_ATTACHMENT_FILE_NAME_LENGTH = 200;
const PHONE_UNLINKED_MESSAGE =
  'К станции можно написать только с привязанным номером телефона. Привяжите номер в профиле.';

/**
 * The provider's dialog and message identifiers stay inside this module. Clients address a dialog by
 * a stable PadlHub UUID derived from the provider id, and the server resolves it by enumerating the
 * caller's own dialogs, so an opaque external id never becomes a public identifier and a caller can
 * never address somebody else's dialog.
 */
function derivedPublicId(tenantId: string, kind: 'dialog' | 'message', providerId: string): string {
  const bytes = createHash('sha256')
    .update(`phub-station-support-v1:${tenantId}:${kind}:${providerId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function author(input: {
  readonly direction: 'INBOUND' | 'OUTBOUND' | 'SYSTEM';
  readonly authorType: string;
}): 'ME' | 'STATION' | 'SYSTEM' {
  if (input.direction === 'SYSTEM') return 'SYSTEM';
  return input.direction === 'INBOUND' && input.authorType.toUpperCase() === 'CLIENT'
    ? 'ME'
    : 'STATION';
}

interface Principal {
  readonly tenantId: string;
  readonly userId: string;
}

function principal(request: FastifyRequest): Principal | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const tenantId = current.tenantId;
  const userId = current.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function viewDialog(
  tenantId: string,
  dialog: StationSupportProviderDialog,
  stationIds: ReadonlyMap<string, string>,
) {
  return {
    id: derivedPublicId(tenantId, 'dialog', dialog.dialogId),
    stationId: dialog.stationId ? (stationIds.get(dialog.stationId) ?? null) : null,
    stationName: dialog.stationName,
    status: dialog.status,
    updatedAt: dialog.updatedAt,
    lastMessage: dialog.lastMessage
      ? {
          preview: dialog.lastMessage.preview,
          author: author(dialog.lastMessage),
          createdAt: dialog.lastMessage.createdAt,
        }
      : null,
  };
}

/**
 * A history page may carry many pictures and every one is a CPU-bound decode, so the fan-out is
 * bounded instead of decoding the whole page at once.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * A replayed idempotency key must prove the same pictures were attached, not only the same text,
 * otherwise the same key would silently answer a different command from the provider's record.
 * Provider names are not identities, so the exact content is compared whenever the provider stored
 * the inline picture we sent; only a re-hosted value falls back to the name and size pair.
 */
function attachmentSignature(
  attachments:
    readonly { readonly name?: string | null; readonly size?: number | null }[] | undefined,
): string {
  return (attachments ?? []).map((item) => `${item.name ?? ''}|${item.size ?? 0}`).join(';');
}

/** Digests of the inline pictures the provider stored; `null` marks a value that is not one. */
function inlineAttachmentDigests(
  attachments: readonly { readonly url?: string }[] | undefined,
): (string | null)[] {
  return (attachments ?? []).map((attachment) => {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)$/i.exec(attachment.url ?? '');
    const base64 = match?.[1];
    return base64 ? createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') : null;
  });
}

function replayedCommandDiffers(
  replayed: StationSupportProviderMessage,
  sentText: string,
  sentHashes: readonly string[],
  sentSignature: string,
): boolean {
  if (replayed.text.trim() !== sentText) return true;
  const stored = replayed.attachments ?? [];
  const digests = inlineAttachmentDigests(stored);
  if (stored.length > 0 && digests.every((digest) => digest !== null)) {
    return (
      digests.length !== sentHashes.length || digests.some((digest, i) => digest !== sentHashes[i])
    );
  }
  return attachmentSignature(stored) !== sentSignature;
}

interface StationSupportViewAttachment {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: 'image/webp';
  readonly byteSize: number;
}

/** The browser loads a picture through PadlHub with its own bearer token, never from the bucket. */
function attachmentContentPath(tenantKey: string, attachmentId: string): string {
  return `/user/api/v1/${encodeURIComponent(tenantKey)}/support/attachments/${attachmentId}/content`;
}

function sanitizeAttachmentFileName(value: string): string {
  const base = value.split(/[\\/]/u).filter(Boolean).pop()?.trim() ?? '';
  const printable = [...base]
    .map((character) => ((character.codePointAt(0) ?? 0) < 0x20 ? '_' : character))
    .join('');
  return printable.slice(0, MAX_ATTACHMENT_FILE_NAME_LENGTH) || 'фото';
}

/**
 * The composer sends the picture as base64 inside the command body, so no extra body parser is
 * registered and this route alone carries the larger limit.
 */
export const ATTACHMENT_UPLOAD_BODY_LIMIT =
  Math.ceil((STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES / 3) * 4) + 4_096;

function decodeAttachmentUpload(encoded: string): Buffer | null {
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  if (encoded.length > ATTACHMENT_UPLOAD_BODY_LIMIT) return null;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.byteLength > 0 ? bytes : null;
}

/**
 * A provider picture becomes one immutable WebP object in the shared PadlHub bucket under the
 * caller's own key, so the legacy URL never reaches the browser and the same bucket serves every
 * chat contour. A picture in a form the deployment refuses leaves the message text-only instead of
 * failing the whole history read.
 */
async function materializeStationSupportAttachments(
  current: Principal,
  message: StationSupportProviderMessage,
  media: StationSupportMediaStore,
  options: {
    readonly allowedHosts: readonly string[];
    readonly timeoutMs: number;
  },
): Promise<readonly StationSupportViewAttachment[]> {
  const attachments: StationSupportViewAttachment[] = [];
  for (const [index, attachment] of (message.attachments ?? [])
    .slice(0, STATION_SUPPORT_MEDIA_MAX_ATTACHMENTS)
    .entries()) {
    try {
      const source = await readStationSupportProviderImage(attachment.url, {
        allowedHosts: options.allowedHosts,
        timeoutMs: options.timeoutMs,
        maxBytes: STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES,
      });
      const webp = await convertStationSupportWebp(source);
      const objectKey = stationSupportMediaObjectKey(current.tenantId, current.userId, webp.sha256);
      if (!(await media.stat(objectKey))) {
        await media.putWebp({
          objectKey,
          body: webp.body,
          sha256: webp.sha256,
          fileName: attachment.name ? sanitizeAttachmentFileName(attachment.name) : null,
        });
      }
      attachments.push({
        id: stationSupportAttachmentId(webp.sha256),
        fileName: attachment.name
          ? sanitizeAttachmentFileName(attachment.name)
          : `фото-${index + 1}.webp`,
        contentType: 'image/webp',
        byteSize: webp.body.byteLength,
      });
    } catch {
      // The provider stored a picture this deployment cannot materialize; the text still renders.
    }
  }
  return attachments;
}

async function viewMessage(
  tenantKey: string,
  current: Principal,
  message: StationSupportProviderMessage,
  media: StationSupportMediaStore | undefined,
  mediaOptions: { readonly allowedHosts: readonly string[]; readonly timeoutMs: number },
  presetAttachments?: readonly StationSupportViewAttachment[],
): Promise<{
  readonly id: string;
  readonly body: string;
  readonly author: 'ME' | 'STATION' | 'SYSTEM';
  readonly authorName: string | null;
  readonly createdAt: string | null;
  readonly attachments: readonly (StationSupportViewAttachment & { readonly url: string })[];
}> {
  const attachments =
    presetAttachments ??
    (media
      ? await materializeStationSupportAttachments(current, message, media, mediaOptions)
      : []);
  return {
    id: derivedPublicId(current.tenantId, 'message', message.messageId),
    body: message.text,
    author: author(message),
    authorName: message.senderName,
    createdAt: message.createdAt,
    attachments: attachments.map((attachment) => ({
      ...attachment,
      url: attachmentContentPath(tenantKey, attachment.id),
    })),
  };
}

/**
 * The provider stores this value on the message and dedupes on it for a short window. Namespacing
 * by tenant and user keeps one client's key from colliding with another's, and hashing keeps the
 * value inside the provider's length budget.
 */
export function stationSupportExternalMessageId(
  tenantId: string,
  userId: string,
  idempotencyKey: string,
): string {
  const digest = createHash('sha256')
    .update(`phub-station-support-v1:${tenantId}:${userId}:${idempotencyKey}`)
    .digest('hex');
  return `phub:${digest.slice(0, 48)}`;
}

export interface StationSupportRoutesOptions {
  readonly enabled: boolean;
  readonly provider?: StationSupportProvider;
  readonly repository?: StationSupportRepository;
  readonly locationRepository?: Pick<LocationRepository, 'listPublished'>;
  readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  readonly commandHandlers: readonly preHandlerHookHandler[];
  /**
   * Absent when the deployment has no media bucket. Chat pictures are then simply not offered: the
   * tab stays text-only instead of failing the whole history read.
   */
  readonly mediaStore?: StationSupportMediaStore;
  /** Hosts a provider-stored picture may be downloaded from; the legacy origin is the only default. */
  readonly mediaAllowedHosts?: readonly string[];
  readonly mediaTimeoutMs?: number;
}

export function registerStationSupportRoutes(
  app: FastifyInstance,
  options: StationSupportRoutesOptions,
): void {
  const ready = (): boolean =>
    options.enabled &&
    Boolean(options.provider && options.repository && options.locationRepository);

  const mediaOptions = {
    allowedHosts: options.mediaAllowedHosts ?? [],
    timeoutMs: options.mediaTimeoutMs ?? 8_000,
  };

  function disabled(request: FastifyRequest, reply: FastifyReply) {
    return sendApiError(
      request,
      reply,
      404,
      'SUPPORT_STATIONS_DISABLED',
      'Чаты со станциями ещё не включены для этой организации.',
    );
  }

  function conflict(request: FastifyRequest, reply: FastifyReply) {
    return sendApiError(
      request,
      reply,
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency-Key уже использован для другой команды.',
    );
  }

  function providerUnavailable(request: FastifyRequest, reply: FastifyReply) {
    return sendApiError(
      request,
      reply,
      503,
      'SUPPORT_PROVIDER_UNAVAILABLE',
      'Сервис обращений к станциям временно недоступен. Попробуйте позже.',
    );
  }

  /**
   * One phone per request. The verified login phone is the stronger identity and outranks the
   * provider-asserted value, matching the existing legacy bridge. Exactly one number is forwarded so
   * the provider can never be asked to merge two viewers' identities into one client.
   */
  async function resolvePhone(
    request: FastifyRequest,
    reply: FastifyReply,
    current: Principal,
    repository: StationSupportRepository,
  ): Promise<string | null> {
    const identity = await repository.readViewerIdentity({
      tenantId: current.tenantId,
      userId: current.userId,
    });
    const phone =
      normalizeSupportPhoneDigits(identity.verifiedPhoneE164) ??
      normalizeSupportPhoneDigits(identity.providerPhoneE164);
    if (!phone) {
      sendApiError(request, reply, 409, 'SUPPORT_IDENTITY_NOT_LINKED', PHONE_UNLINKED_MESSAGE);
      return null;
    }
    return phone;
  }

  async function loadDialogs(
    current: Principal,
    repository: StationSupportRepository,
    provider: StationSupportProvider,
    correlationId: string,
    phoneDigits: string,
  ) {
    const listed = await provider.listDialogs({ phoneDigits, correlationId });
    // The published contract caps the list at 200, and the reverse station mapping below is capped
    // the same way, so the newest 200 dialogs are selected explicitly instead of truncated later.
    const dialogs = [...listed]
      .sort((left, right) => right.updatedTs - left.updatedTs)
      .slice(0, MAX_STATION_DIALOGS);
    const stationIds = await repository.readStationIdsByLegacyExternalIds({
      tenantId: current.tenantId,
      externalIds: dialogs.flatMap((dialog) => (dialog.stationId ? [dialog.stationId] : [])),
    });
    return { dialogs, stationIds };
  }

  app.get(
    '/user/api/v1/:tenantKey/support/stations',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!ready()) return disabled(request, reply);
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const locations = await options.locationRepository!.listPublished(current.tenantId, {
        limit: 100,
      });
      return {
        items: locations
          .map((location) => ({ id: location.id, name: location.title }))
          .sort((left, right) => left.name.localeCompare(right.name, 'ru-RU')),
      };
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/support/dialogs',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!ready()) return disabled(request, reply);
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const phone = await resolvePhone(request, reply, current, options.repository!);
      if (!phone) return reply;
      try {
        const { dialogs, stationIds } = await loadDialogs(
          current,
          options.repository!,
          options.provider!,
          request.id,
          phone,
        );
        return {
          items: dialogs.map((dialog) => viewDialog(current.tenantId, dialog, stationIds)),
        };
      } catch (error) {
        if (error instanceof StationSupportProviderError)
          return providerUnavailable(request, reply);
        throw error;
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/support/dialogs/:dialogId/messages',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!ready()) return disabled(request, reply);
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const dialogId = (request.params as { dialogId: string }).dialogId;
      if (!UUID_PATTERN.test(dialogId)) {
        return sendApiError(request, reply, 404, 'SUPPORT_DIALOG_NOT_FOUND', 'Диалог не найден.');
      }
      const phone = await resolvePhone(request, reply, current, options.repository!);
      if (!phone) return reply;
      try {
        const { dialogs } = await loadDialogs(
          current,
          options.repository!,
          options.provider!,
          request.id,
          phone,
        );
        const dialog = dialogs.find(
          (item) => derivedPublicId(current.tenantId, 'dialog', item.dialogId) === dialogId,
        );
        if (!dialog) {
          return sendApiError(request, reply, 404, 'SUPPORT_DIALOG_NOT_FOUND', 'Диалог не найден.');
        }
        const messages = await options.provider!.listMessages({
          dialogId: dialog.dialogId,
          limit: MESSAGE_PAGE_LIMIT,
          beforeTs: Date.now() + 1,
          correlationId: request.id,
        });
        const tenantKey = (request.params as { tenantKey: string }).tenantKey;
        return {
          items: await mapWithConcurrency(messages, 3, (message) =>
            viewMessage(tenantKey, current, message, options.mediaStore, mediaOptions),
          ),
        };
      } catch (error) {
        if (error instanceof StationSupportProviderError)
          return providerUnavailable(request, reply);
        throw error;
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/support/messages',
    {
      preHandler: [...options.commandHandlers],
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!ready()) return disabled(request, reply);
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const body = request.body as Record<string, unknown> | null;
      const stationId = typeof body?.stationId === 'string' ? body.stationId : null;
      const dialogId = typeof body?.dialogId === 'string' ? body.dialogId : null;
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      const attachmentIds = Array.isArray(body?.attachmentIds)
        ? body.attachmentIds.filter((value): value is string => typeof value === 'string')
        : [];
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) => !['stationId', 'dialogId', 'text', 'attachmentIds'].includes(key),
        ) ||
        (stationId === null) === (dialogId === null) ||
        (stationId !== null && !UUID_PATTERN.test(stationId)) ||
        (dialogId !== null && !UUID_PATTERN.test(dialogId)) ||
        (text.length === 0 && attachmentIds.length === 0) ||
        text.length > MAX_MESSAGE_LENGTH ||
        attachmentIds.length > STATION_SUPPORT_MEDIA_MAX_ATTACHMENTS ||
        new Set(attachmentIds).size !== attachmentIds.length ||
        (Array.isArray(body.attachmentIds) && attachmentIds.length !== body.attachmentIds.length)
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'SUPPORT_MESSAGE_INVALID',
          'Укажите станцию или диалог, текст до 4000 символов и не более 4 фотографий.',
        );
      }
      const repository = options.repository!;
      const provider = options.provider!;
      const tenantKey = (request.params as { tenantKey: string }).tenantKey;
      const idempotencyKey = request.headers['idempotency-key'] as string;

      // A picture is addressed by the digest of the WebP object this API stored for this very user,
      // so a caller can only ever attach its own upload and the provider receives durable inline
      // bytes instead of a link that would expire inside the operator's own message record.
      const presetAttachments: StationSupportViewAttachment[] = [];
      const eventAttachments: StationSupportEventAttachment[] = [];
      const sentAttachmentHashes: string[] = [];
      let forwardedBase64Bytes = 0;
      if (attachmentIds.length > 0) {
        if (!options.mediaStore) {
          return sendApiError(
            request,
            reply,
            503,
            'SUPPORT_ATTACHMENTS_UNAVAILABLE',
            'Фотографии временно недоступны.',
          );
        }
        for (const attachmentId of attachmentIds) {
          const sha256 = stationSupportAttachmentSha256(attachmentId);
          if (!sha256) {
            return sendApiError(
              request,
              reply,
              400,
              'SUPPORT_ATTACHMENT_INVALID',
              'Фото не распознано. Прикрепите его заново.',
            );
          }
          const objectKey = stationSupportMediaObjectKey(current.tenantId, current.userId, sha256);
          const stored = await options.mediaStore.stat(objectKey).catch(() => undefined);
          const bytes = stored
            ? await options.mediaStore
                .read(objectKey, STATION_SUPPORT_MEDIA_MAX_BYTES)
                .catch(() => undefined)
            : undefined;
          if (!stored || !bytes) {
            return sendApiError(
              request,
              reply,
              409,
              'SUPPORT_ATTACHMENT_NOT_FOUND',
              'Фото не найдено. Прикрепите его заново.',
            );
          }
          forwardedBase64Bytes += Math.ceil(bytes.byteLength / 3) * 4;
          if (forwardedBase64Bytes > STATION_SUPPORT_MEDIA_INLINE_URL_BUDGET_BYTES) {
            return sendApiError(
              request,
              reply,
              400,
              'SUPPORT_ATTACHMENT_TOO_LARGE',
              'Суммарный размер фотографий слишком большой. Приложите меньше или сожмите их.',
            );
          }
          sentAttachmentHashes.push(createHash('sha256').update(bytes).digest('hex'));
          const fileName = stored.fileName ?? 'фото.webp';
          presetAttachments.push({
            id: attachmentId,
            fileName,
            contentType: 'image/webp',
            byteSize: bytes.byteLength,
          });
          eventAttachments.push({
            type: 'IMAGE',
            url: `data:image/webp;base64,${bytes.toString('base64')}`,
            name: fileName,
            mimeType: 'image/webp',
            size: bytes.byteLength,
          });
        }
      }
      // The operator inbox reads one line per message, so a picture-only message still carries the
      // same preview text the CUP workspace itself writes for one of its own pictures.
      const sentText =
        text ||
        (eventAttachments.length > 0
          ? eventAttachments.length === 1
            ? `Фото: ${eventAttachments[0]?.name ?? ''}`.trim()
            : `Фото (+${eventAttachments.length - 1})`
          : '');
      const sentAttachmentSignature = attachmentSignature(eventAttachments);

      const phone = await resolvePhone(request, reply, current, repository);
      if (!phone) return reply;

      let target: { dialogId: string | null; stationId: string; stationName: string };
      if (dialogId !== null) {
        const loaded = await loadDialogs(current, repository, provider, request.id, phone).catch(
          (error: unknown) => {
            if (error instanceof StationSupportProviderError) return null;
            throw error;
          },
        );
        if (!loaded) return providerUnavailable(request, reply);
        const match = loaded.dialogs.find(
          (item) => derivedPublicId(current.tenantId, 'dialog', item.dialogId) === dialogId,
        );
        if (!match) {
          return sendApiError(request, reply, 404, 'SUPPORT_DIALOG_NOT_FOUND', 'Диалог не найден.');
        }
        if (match.status.toUpperCase() === 'CLOSED') {
          return sendApiError(
            request,
            reply,
            409,
            'SUPPORT_DIALOG_CLOSED',
            'Обращение закрыто. Начните новое обращение к станции.',
          );
        }
        target = {
          dialogId: match.dialogId,
          stationId: match.stationId ?? 'UNASSIGNED',
          stationName: match.stationName,
        };
      } else {
        const legacyStationId = await repository.readLegacyStationExternalId({
          tenantId: current.tenantId,
          stationId: stationId!,
        });
        if (!legacyStationId) {
          return sendApiError(
            request,
            reply,
            409,
            'SUPPORT_STATION_NOT_BOUND',
            'Станция ещё не связана с обращениями. Выберите другую станцию.',
          );
        }
        const locations = await options.locationRepository!.listPublished(current.tenantId, {
          limit: 100,
        });
        const location = locations.find((item) => item.id === stationId);
        if (!location) {
          return sendApiError(
            request,
            reply,
            404,
            'SUPPORT_STATION_UNKNOWN',
            'Станция не найдена.',
          );
        }
        const existing = await loadDialogs(current, repository, provider, request.id, phone).catch(
          (error: unknown) => {
            if (error instanceof StationSupportProviderError) return null;
            throw error;
          },
        );
        if (!existing) return providerUnavailable(request, reply);
        const match =
          existing.dialogs.find(
            (item) => item.stationId === legacyStationId && item.status.toUpperCase() !== 'CLOSED',
          ) ?? null;
        target = {
          dialogId: match?.dialogId ?? null,
          stationId: legacyStationId,
          stationName: match?.stationName ?? location.title,
        };
      }

      // A retry of an already accepted command is answered from the provider's own record: the
      // derived external message id is stored on the message. The stored body must match, otherwise
      // the same key is being reused for a different command and must not silently drop the text.
      const providerMessageId = stationSupportExternalMessageId(
        current.tenantId,
        current.userId,
        idempotencyKey,
      );
      if (target.dialogId) {
        const replayed = await findSentMessage(
          provider,
          target.dialogId,
          providerMessageId,
          request.id,
        ).catch(() => null);
        if (replayed) {
          if (
            replayedCommandDiffers(
              replayed,
              sentText,
              sentAttachmentHashes,
              sentAttachmentSignature,
            )
          ) {
            return conflict(request, reply);
          }
          // The replayed answer describes what the operator actually received, so its pictures come
          // from the provider record instead of the current command's uploads.
          return {
            dialogId: derivedPublicId(current.tenantId, 'dialog', target.dialogId),
            message: await viewMessage(
              tenantKey,
              current,
              replayed,
              options.mediaStore,
              mediaOptions,
            ),
            replayed: true,
          };
        }
      }

      try {
        const sent = await provider.sendEvent({
          phoneDigits: phone,
          externalUserId: current.userId,
          externalChatId: `lk2:${current.userId}`,
          displayName: 'Игрок ПадлХАБ',
          text: sentText,
          stationId: target.stationId,
          stationName: target.stationName,
          ...(eventAttachments.length > 0 ? { attachments: eventAttachments } : {}),
          externalMessageId: providerMessageId,
          correlationId: request.id,
        });
        // A 2xx without a parsable dialog id is still an accepted write for a new dialog, so the
        // same read-back recovery runs before the command may be reported as failed.
        const resolvedDialogId = sent.dialogId ?? target.dialogId;
        if (!resolvedDialogId) {
          const recoveredOnly = await recoverSentMessage(
            provider,
            request.id,
            phone,
            null,
            target.stationId,
            providerMessageId,
          ).catch(() => null);
          if (recoveredOnly) {
            return {
              dialogId: derivedPublicId(current.tenantId, 'dialog', recoveredOnly.dialogId),
              message: await viewMessage(
                tenantKey,
                current,
                recoveredOnly.message,
                options.mediaStore,
                mediaOptions,
                presetAttachments,
              ),
              replayed: true,
            };
          }
          return providerUnavailable(request, reply);
        }
        const message = await findSentMessage(
          provider,
          resolvedDialogId,
          providerMessageId,
          request.id,
        ).catch(() => null);
        return {
          dialogId: derivedPublicId(current.tenantId, 'dialog', resolvedDialogId),
          message: message
            ? await viewMessage(
                tenantKey,
                current,
                message,
                options.mediaStore,
                mediaOptions,
                presetAttachments,
              )
            : null,
          replayed: false,
        };
      } catch (error) {
        if (!(error instanceof StationSupportProviderError)) throw error;
        if (error.code === 'SUPPORT_PROVIDER_REJECTED') {
          return sendApiError(
            request,
            reply,
            422,
            'SUPPORT_MESSAGE_REJECTED',
            'Станция отклонила обращение. Проверьте текст и попробуйте снова.',
          );
        }
        // Ambiguous write recovery: a timeout or 5xx may still have committed the message, so read
        // the provider back before reporting failure. The retried command is safe either way.
        const recovered = await recoverSentMessage(
          provider,
          request.id,
          phone,
          target.dialogId,
          target.stationId,
          providerMessageId,
        ).catch(() => null);
        if (recovered) {
          return {
            dialogId: derivedPublicId(current.tenantId, 'dialog', recovered.dialogId),
            message: await viewMessage(
              tenantKey,
              current,
              recovered.message,
              options.mediaStore,
              mediaOptions,
              presetAttachments,
            ),
            replayed: true,
          };
        }
        return providerUnavailable(request, reply);
      }
    },
  );

  /**
   * Uploads one chat picture. The bytes are validated, re-encoded to WebP and stored under the
   * caller's own content-addressed key; the returned id is the only handle the send command needs.
   * Nothing is written to the legacy contour here, so an abandoned upload leaves no provider state.
   */
  app.post(
    '/user/api/v1/:tenantKey/support/attachments',
    {
      preHandler: [...options.commandHandlers],
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
      bodyLimit: ATTACHMENT_UPLOAD_BODY_LIMIT,
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!ready()) return disabled(request, reply);
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.mediaStore) {
        return sendApiError(
          request,
          reply,
          503,
          'SUPPORT_ATTACHMENTS_UNAVAILABLE',
          'Фотографии временно недоступны.',
        );
      }
      const body = request.body as Record<string, unknown> | null;
      const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
      const declaredType = typeof body?.contentType === 'string' ? body.contentType : '';
      const encoded = typeof body?.data === 'string' ? body.data : '';
      const source = decodeAttachmentUpload(encoded);
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['fileName', 'contentType', 'data'].includes(key)) ||
        fileName.length === 0 ||
        fileName.length > MAX_ATTACHMENT_FILE_NAME_LENGTH ||
        !isStationSupportImageContentType(declaredType) ||
        !source ||
        source.byteLength > STATION_SUPPORT_MEDIA_SOURCE_MAX_BYTES
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'SUPPORT_ATTACHMENT_INVALID',
          'Можно приложить одно изображение JPEG, PNG или WebP до 8 МБ.',
        );
      }
      let webp: { readonly body: Buffer; readonly sha256: string };
      try {
        webp = await convertStationSupportWebp(source);
      } catch {
        return sendApiError(
          request,
          reply,
          422,
          'SUPPORT_ATTACHMENT_REJECTED',
          'Не удалось обработать изображение. Выберите другой файл.',
        );
      }
      const objectKey = stationSupportMediaObjectKey(current.tenantId, current.userId, webp.sha256);
      const storedName = sanitizeAttachmentFileName(fileName);
      try {
        await options.mediaStore.putWebp({
          objectKey,
          body: webp.body,
          sha256: webp.sha256,
          fileName: storedName,
        });
      } catch {
        return sendApiError(
          request,
          reply,
          503,
          'SUPPORT_ATTACHMENTS_UNAVAILABLE',
          'Фотографии временно недоступны.',
        );
      }
      const tenantKey = (request.params as { tenantKey: string }).tenantKey;
      const id = stationSupportAttachmentId(webp.sha256);
      return {
        id,
        fileName: storedName,
        contentType: 'image/webp',
        byteSize: webp.body.byteLength,
        url: attachmentContentPath(tenantKey, id),
      };
    },
  );

  /**
   * Serves one chat picture to its owner. The browser sends its PadlHub token and receives a redirect
   * to a short-lived signed storage URL, so the bucket stays private and no provider URL is exposed.
   */
  app.get(
    '/user/api/v1/:tenantKey/support/attachments/:attachmentId/content',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!ready()) return disabled(request, reply);
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const media = options.mediaStore;
      const sha256 = stationSupportAttachmentSha256(
        (request.params as { attachmentId: string }).attachmentId,
      );
      const attachmentMissing = () =>
        sendApiError(request, reply, 404, 'SUPPORT_ATTACHMENT_NOT_FOUND', 'Фото не найдено.');
      if (!media || !sha256) return attachmentMissing();
      const objectKey = stationSupportMediaObjectKey(current.tenantId, current.userId, sha256);
      const stored = await media.stat(objectKey).catch(() => undefined);
      if (!stored) return attachmentMissing();
      try {
        const url = await media.createDeliveryUrl({
          objectKey,
          contentType: 'image/webp',
          expiresInSeconds: STATION_SUPPORT_MEDIA_URL_TTL_SECONDS,
        });
        return reply.code(302).header('Location', url).send();
      } catch {
        return sendApiError(
          request,
          reply,
          503,
          'SUPPORT_ATTACHMENTS_UNAVAILABLE',
          'Фотографии временно недоступны.',
        );
      }
    },
  );
}

async function findSentMessage(
  provider: StationSupportProvider,
  dialogId: string,
  externalMessageId: string,
  correlationId: string,
): Promise<StationSupportProviderMessage | null> {
  const messages = await provider.listMessages({
    dialogId,
    limit: MESSAGE_PAGE_LIMIT,
    beforeTs: Date.now() + 1,
    correlationId,
  });
  return messages.find((message) => message.externalMessageId === externalMessageId) ?? null;
}

async function recoverSentMessage(
  provider: StationSupportProvider,
  correlationId: string,
  phoneDigits: string,
  knownDialogId: string | null,
  legacyStationId: string,
  externalMessageId: string,
): Promise<{ readonly dialogId: string; readonly message: StationSupportProviderMessage } | null> {
  const dialogs = await provider.listDialogs({ phoneDigits, correlationId });
  const candidates = knownDialogId
    ? dialogs.filter((dialog) => dialog.dialogId === knownDialogId)
    : dialogs.filter((dialog) => dialog.stationId === legacyStationId);
  for (const dialog of candidates) {
    const message = await findSentMessage(
      provider,
      dialog.dialogId,
      externalMessageId,
      correlationId,
    );
    if (message) return { dialogId: dialog.dialogId, message };
  }
  return null;
}
