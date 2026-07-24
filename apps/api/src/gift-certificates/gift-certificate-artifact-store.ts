import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface GiftCertificateArtifactReadStore {
  readPdf(key: string, maxBytes: number): Promise<Buffer>;
}

export class S3GiftCertificateArtifactReadStore implements GiftCertificateArtifactReadStore {
  private readonly client: S3Client;
  private consecutiveFailures = 0;
  private openUntil = 0;

  public constructor(
    private readonly options: {
      readonly endpoint: string;
      readonly region: string;
      readonly bucket: string;
      readonly accessKey: string;
      readonly secretKey: string;
      readonly forcePathStyle: boolean;
      readonly timeoutMs: number;
      readonly circuitFailureThreshold?: number;
      readonly circuitResetMs?: number;
    },
  ) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      forcePathStyle: options.forcePathStyle,
      maxAttempts: 2,
    });
  }

  private async sendWithTimeout<TResult>(operation: (signal: AbortSignal) => Promise<TResult>) {
    if (this.openUntil > Date.now()) throw new Error('GIFT_CERTIFICATE_ARTIFACT_CIRCUIT_OPEN');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const result = await operation(controller.signal);
      this.consecutiveFailures = 0;
      this.openUntil = 0;
      return result;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 3)) {
        this.openUntil = Date.now() + (this.options.circuitResetMs ?? 30_000);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async readPdf(key: string, maxBytes: number): Promise<Buffer> {
    const response = await this.sendWithTimeout((abortSignal) =>
      this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), {
        abortSignal,
      }),
    );
    if (!response.Body || response.ContentType !== 'application/pdf') {
      throw new Error('GIFT_CERTIFICATE_ARTIFACT_INVALID');
    }
    if ((response.ContentLength ?? 0) > maxBytes) {
      throw new Error('GIFT_CERTIFICATE_ARTIFACT_TOO_LARGE');
    }
    const body = Buffer.from(await response.Body.transformToByteArray());
    if (
      body.length < 1_024 ||
      body.length > maxBytes ||
      body.subarray(0, 5).toString() !== '%PDF-'
    ) {
      throw new Error('GIFT_CERTIFICATE_ARTIFACT_INVALID');
    }
    return body;
  }
}
