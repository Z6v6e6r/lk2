/**
 * Chat photo normalization in front of the media upload.
 *
 * Chat media storage serves the exact bytes a client PUTs into the quarantine bucket, so a phone
 * photo keeps its original multi-megabyte JPEG payload all the way to the reader. The composer
 * therefore re-encodes a raster photo to WebP before the upload intent is issued: the picture
 * uploads faster, and every later open of the message loads a smaller object, without a server
 * variant, schema or delivery change.
 *
 * The conversion is best effort by contract. A picture is never lost to a codec detail: an
 * environment without a canvas, bytes the browser cannot decode, a header that does not describe a
 * plain raster image, a picture above the decode budget, or an encoded result that is not smaller
 * all keep the original file, which is exactly today's behaviour.
 */

/** Only these two are re-encoded; a WebP upload already is the target format and stays untouched. */
export const CHAT_IMAGE_WEBP_SOURCE_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const;

/**
 * The station-support photo contour uses the same bound, so one product shrinks pictures alike.
 *
 * Both literals below are the tuned values of the first landing: 1600 px keeps a retina phone photo
 * readable in the chat while staying well under the upload budget, and 0.82 keeps the WebP smaller
 * than the source JPEG without visible banding. They are the only surface the bounded tuning class
 * may move, so a later change to either value travels the Web-only route.
 */
export const CHAT_IMAGE_WEBP_MAX_DIMENSION = 1_600;
export const CHAT_IMAGE_WEBP_QUALITY = 0.82;

/**
 * Decoding happens on the sender's device, so an absurd header must never cause an unbounded
 * allocation. A picture above this budget is uploaded untouched instead of being converted; the
 * value mirrors the station-support `limitInputPixels` guard.
 */
export const CHAT_IMAGE_WEBP_MAX_PIXELS = 40_000_000;

export interface RasterImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface ChatImageWebpSource {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
}

export interface ChatImageWebpTarget {
  readonly maxDimension: number;
  readonly quality: number;
}

export interface ChatImageWebpEncoder {
  /** Returns WebP bytes, or `undefined` when this environment cannot produce them. */
  encodeWebp(source: ChatImageWebpSource, target: ChatImageWebpTarget): Promise<Blob | undefined>;
}

function byteAt(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset >= bytes.byteLength) return 0;
  return bytes[offset] ?? 0;
}

function uint16BigEndian(bytes: Uint8Array, offset: number): number {
  return (byteAt(bytes, offset) << 8) | byteAt(bytes, offset + 1);
}

function uint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    ((byteAt(bytes, offset) << 24) |
      (byteAt(bytes, offset + 1) << 16) |
      (byteAt(bytes, offset + 2) << 8) |
      byteAt(bytes, offset + 3)) >>>
    0
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => byteAt(bytes, index) === byte);
}

/** `IHDR` always follows the 8-byte signature and a single 4-byte chunk length. */
function readPngDimensions(bytes: Uint8Array): RasterImageDimensions | undefined {
  if (bytes.byteLength < 24 || !isPng(bytes)) return undefined;
  const chunkType = String.fromCharCode(
    byteAt(bytes, 12),
    byteAt(bytes, 13),
    byteAt(bytes, 14),
    byteAt(bytes, 15),
  );
  if (chunkType !== 'IHDR') return undefined;
  const width = uint32BigEndian(bytes, 16);
  const height = uint32BigEndian(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Walks the JPEG marker chain to the first frame header. Entropy-coded data is never entered: a
 * file without a start-of-frame before its start-of-scan has no dimensions to report.
 */
function readJpegDimensions(bytes: Uint8Array): RasterImageDimensions | undefined {
  if (byteAt(bytes, 0) !== 0xff || byteAt(bytes, 1) !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (byteAt(bytes, offset) !== 0xff) return undefined;
    const marker = byteAt(bytes, offset + 1);
    // A padding `0xFF` before the marker code is skipped one byte at a time.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return undefined;
    const segmentLength = uint16BigEndian(bytes, offset + 2);
    if (segmentLength < 2) return undefined;
    // SOF0..SOF15 except the Huffman, extension and arithmetic-conditioning tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.byteLength) return undefined;
      const height = uint16BigEndian(bytes, offset + 5);
      const width = uint16BigEndian(bytes, offset + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

/** Reads the stored pixel size of the two formats this contour converts. */
export function readRasterImageDimensions(
  bytes: Uint8Array,
  contentType: string,
): RasterImageDimensions | undefined {
  if (contentType === 'image/png') return readPngDimensions(bytes);
  if (contentType === 'image/jpeg') return readJpegDimensions(bytes);
  return undefined;
}

/** Bounds the longer side, never enlarges and never returns a zero side. */
export function fitWithinMaxDimension(
  dimensions: RasterImageDimensions,
  maxDimension: number,
): RasterImageDimensions | undefined {
  const { width, height } = dimensions;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return undefined;
  }
  if (!Number.isFinite(maxDimension) || maxDimension < 1) return undefined;
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The composer keeps one display name per picture, so the extension follows the stored bytes. */
export function chatWebpFileName(fileName: string): string {
  const name = fileName.trim();
  const withoutExtension = name.replace(/\.[A-Za-z0-9]{1,10}$/u, '').trim();
  return `${withoutExtension.length > 0 ? withoutExtension : 'фото'}.webp`;
}

/**
 * One decode at a time. Four phone photos converted in parallel would hold four full-size bitmaps,
 * which is how a mobile webview runs out of memory; the uploads themselves still run in parallel,
 * because only the transient decode and encode step waits in line.
 */
let conversionChain: Promise<unknown> = Promise.resolve();

/**
 * Conversions run one at a time. A gallery selection would otherwise start as many full-size decodes
 * as it has photos on one thread, and the sender would feel that as a stalled composer rather than as
 * faster uploads.
 */
function serializeConversion<T>(task: () => Promise<T>): Promise<T> {
  // A failed conversion must not poison the chain for the next picture.
  const result = conversionChain.then(task, task);
  conversionChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function normalizedContentType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Returns the file the upload should send: the WebP re-encode when this environment produced one
 * that is actually smaller, otherwise the untouched original. It never throws, so an upload can
 * only fail on the media API's own terms.
 */
export async function prepareChatPhotoForUpload(
  file: File,
  encoder: ChatImageWebpEncoder = browserChatImageWebpEncoder(),
): Promise<File> {
  const contentType = normalizedContentType(file.type);
  if (!(CHAT_IMAGE_WEBP_SOURCE_CONTENT_TYPES as readonly string[]).includes(contentType))
    return file;
  if (!(file.size > 0)) return file;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dimensions = readRasterImageDimensions(bytes, contentType);
    if (!dimensions) return file;
    if (dimensions.width * dimensions.height > CHAT_IMAGE_WEBP_MAX_PIXELS) return file;
    const encoded = await serializeConversion(() =>
      encoder.encodeWebp(
        { bytes, contentType },
        { maxDimension: CHAT_IMAGE_WEBP_MAX_DIMENSION, quality: CHAT_IMAGE_WEBP_QUALITY },
      ),
    );
    if (!encoded) return file;
    if (!normalizedContentType(encoded.type).startsWith('image/webp')) return file;
    // A re-encode that grew the picture would make both the upload and the later open slower.
    if (encoded.size < 1 || encoded.size >= file.size) return file;
    return new File([encoded], chatWebpFileName(file.name), {
      type: 'image/webp',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}

interface DecodedRasterImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  release(): void;
}

type EncodingCanvas = HTMLCanvasElement | OffscreenCanvas;

function decodeWithImageElement(blob: Blob): Promise<DecodedRasterImage | undefined> {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return Promise.resolve(undefined);
  }
  const objectUrl = URL.createObjectURL(blob);
  return new Promise<DecodedRasterImage | undefined>((resolve) => {
    const image = new Image();
    image.onload = () => {
      resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release: () => {
          URL.revokeObjectURL(objectUrl);
        },
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(undefined);
    };
    image.src = objectUrl;
  });
}

/**
 * Decodes with the orientation baked in, so a rotated phone photo is not silently turned on its
 * side by the re-encode. The promise-based bitmap path is preferred; an `<img>` element is the
 * fallback for engines that do not implement it.
 */
async function decodeRasterImage(
  source: ChatImageWebpSource,
): Promise<DecodedRasterImage | undefined> {
  const blob = new Blob([source.bytes], { type: source.contentType });
  const createBitmap = (
    globalThis as {
      createImageBitmap?: (input: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>;
    }
  ).createImageBitmap;
  if (typeof createBitmap === 'function') {
    try {
      const bitmap = await createBitmap(blob, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => {
          bitmap.close();
        },
      };
    } catch {
      // Fall through to the element path; a rejected bitmap is not a rejected upload.
    }
  }
  return decodeWithImageElement(blob);
}

function createEncodingCanvas(width: number, height: number): EncodingCanvas | undefined {
  const Offscreen = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  if (typeof Offscreen === 'function') {
    try {
      return new Offscreen(width, height);
    } catch {
      // An engine that exposes the constructor but refuses this size still has a DOM canvas.
    }
  }
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToWebpBlob(canvas: EncodingCanvas, quality: number): Promise<Blob | undefined> {
  const offscreen = canvas as OffscreenCanvas;
  if (typeof offscreen.convertToBlob === 'function') {
    return offscreen
      .convertToBlob({ type: 'image/webp', quality })
      .then((blob) => blob ?? undefined)
      .catch(() => undefined);
  }
  const element = canvas as HTMLCanvasElement;
  if (typeof element.toBlob !== 'function') return Promise.resolve(undefined);
  // An engine that cannot encode WebP answers with its default type; the caller checks the type and
  // keeps the original bytes in that case.
  return new Promise((resolve) => {
    element.toBlob((blob) => resolve(blob ?? undefined), 'image/webp', quality);
  });
}

/**
 * The browser codec. The fitted size is computed from the decoded bitmap, not from the file header,
 * so an EXIF-rotated picture keeps its aspect ratio instead of being stretched into the header's
 * width and height.
 */
async function encodeWebpWithCanvas(
  source: ChatImageWebpSource,
  target: ChatImageWebpTarget,
): Promise<Blob | undefined> {
  const decoded = await decodeRasterImage(source);
  if (!decoded) return undefined;
  try {
    const fitted = fitWithinMaxDimension(
      { width: decoded.width, height: decoded.height },
      target.maxDimension,
    );
    if (!fitted) return undefined;
    const canvas = createEncodingCanvas(fitted.width, fitted.height);
    if (!canvas) return undefined;
    const context = (canvas as HTMLCanvasElement).getContext('2d');
    if (!context) return undefined;
    context.drawImage(decoded.source, 0, 0, fitted.width, fitted.height);
    return await canvasToWebpBlob(canvas, target.quality);
  } catch {
    return undefined;
  } finally {
    decoded.release();
  }
}

export function browserChatImageWebpEncoder(): ChatImageWebpEncoder {
  return { encodeWebp: encodeWebpWithCanvas };
}
