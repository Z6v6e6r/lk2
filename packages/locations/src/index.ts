import { z } from 'zod';

const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const nullableDateTime = dateTime.nullable();
const publicRoute = z.string().startsWith('/');
const nullableText = (maxLength: number) => z.string().trim().min(1).max(maxLength).nullable();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const locationPublicationStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
export type LocationPublicationStatus = z.infer<typeof locationPublicationStatusSchema>;

export const locationWeekdaySchema = z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
export type LocationWeekday = z.infer<typeof locationWeekdaySchema>;

export const locationAmenityIconSchema = z.enum([
  'PARKING',
  'CAFE',
  'CHANGING_ROOM',
  'SHOWER',
  'SAUNA',
  'RENTAL',
  'SHOP',
  'ACCESSIBILITY',
  'KIDS',
  'LOUNGE',
  'OTHER',
]);
export type LocationAmenityIcon = z.infer<typeof locationAmenityIconSchema>;

export const locationHoursIntervalSchema = z
  .object({
    opensAt: time,
    closesAt: time,
  })
  .strict()
  .refine((value) => value.opensAt !== value.closesAt, {
    message: 'opening and closing time must differ',
  });

export const locationWeeklyHoursSchema = z
  .array(
    z
      .object({
        weekday: locationWeekdaySchema,
        closed: z.boolean(),
        intervals: z.array(locationHoursIntervalSchema).max(3),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.closed && value.intervals.length > 0) {
          context.addIssue({
            code: 'custom',
            path: ['intervals'],
            message: 'closed days cannot contain intervals',
          });
        }
        if (!value.closed && value.intervals.length === 0) {
          context.addIssue({
            code: 'custom',
            path: ['intervals'],
            message: 'open days require an interval',
          });
        }
      }),
  )
  .max(7)
  .superRefine((entries, context) => {
    const seen = new Set<LocationWeekday>();
    entries.forEach((entry, index) => {
      if (seen.has(entry.weekday)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'weekday'],
          message: 'weekday must be unique',
        });
      }
      seen.add(entry.weekday);
    });
  });

export const locationAmenitySchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    icon: locationAmenityIconSchema,
    title: z.string().trim().min(1).max(120),
    description: nullableText(300),
    sortOrder: z.number().int().min(0).max(99),
  })
  .strict();
export type LocationAmenity = z.infer<typeof locationAmenitySchema>;

export const locationGalleryImageSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2_000)
      .refine((value) => value.startsWith('https://'), 'gallery images must use HTTPS'),
    alt: z.string().trim().max(180),
    isCover: z.boolean(),
    sortOrder: z.number().int().min(0).max(99),
  })
  .strict();
export type LocationGalleryImage = z.infer<typeof locationGalleryImageSchema>;

const locationEditorialFields = {
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,78}$/),
  title: z.string().trim().min(1).max(120),
  shortTitle: nullableText(80),
  city: nullableText(120),
  courtCount: z.number().int().min(0).max(999),
  address: nullableText(500),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  timezone: z.string().min(1).max(100),
  metroName: nullableText(160),
  metroDistanceMeters: z.number().int().min(0).max(100_000).nullable(),
  phoneE164: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .nullable(),
  workingHours: locationWeeklyHoursSchema,
  amenities: z.array(locationAmenitySchema).max(16),
  gallery: z.array(locationGalleryImageSchema).max(12),
  publicationStatus: locationPublicationStatusSchema,
  showOnHome: z.boolean(),
  sortOrder: z.number().int().min(0).max(9_999),
} as const;

export const locationProfileInputSchema = z
  .object(locationEditorialFields)
  .strict()
  .superRefine((value, context) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format();
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['timezone'],
        message: 'timezone must be a valid IANA identifier',
      });
    }
    if ((value.latitude === null) !== (value.longitude === null)) {
      context.addIssue({
        code: 'custom',
        path: ['latitude'],
        message: 'latitude and longitude must be provided together',
      });
    }
    const urls = new Set<string>();
    value.gallery.forEach((image, index) => {
      if (urls.has(image.url)) {
        context.addIssue({
          code: 'custom',
          path: ['gallery', index, 'url'],
          message: 'gallery image URL must be unique',
        });
      }
      urls.add(image.url);
    });
    const coverCount = value.gallery.filter((image) => image.isCover).length;
    if (value.gallery.length > 0 && coverCount !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['gallery'],
        message: 'gallery must have exactly one cover image',
      });
    }
  });
export type LocationProfileInput = z.infer<typeof locationProfileInputSchema>;

export const locationCompletenessSchema = z
  .object({
    percent: z.number().int().min(0).max(100),
    readyToPublish: z.boolean(),
    missingFields: z.array(
      z.enum(['cover', 'city', 'courts', 'address', 'coordinates', 'phone', 'working_hours']),
    ),
  })
  .strict();
export type LocationCompleteness = z.infer<typeof locationCompletenessSchema>;

export const locationAdminViewSchema = z
  .object({
    id: uuid,
    ...locationEditorialFields,
    version: z.number().int().positive(),
    completeness: locationCompletenessSchema,
    createdAt: dateTime,
    updatedAt: dateTime,
    publishedAt: nullableDateTime,
    archivedAt: nullableDateTime,
  })
  .strict();
export type LocationAdminView = z.infer<typeof locationAdminViewSchema>;

export const locationAdminListSchema = z
  .object({
    items: z.array(locationAdminViewSchema).max(500),
  })
  .strict();

export const locationSummarySchema = z
  .object({
    id: uuid,
    title: z.string().min(1).max(120),
    city: nullableText(120),
    courtCount: z.number().int().min(0),
    coverImageUrl: z.string().url().nullable(),
    route: publicRoute,
  })
  .strict();
export type LocationSummary = z.infer<typeof locationSummarySchema>;

export const locationListSchema = z
  .object({
    items: z.array(locationSummarySchema).max(100),
  })
  .strict();
export type LocationList = z.infer<typeof locationListSchema>;

export const locationDetailSchema = z
  .object({
    id: uuid,
    slug: z.string(),
    title: z.string().min(1).max(120),
    shortTitle: nullableText(80),
    city: nullableText(120),
    courtCount: z.number().int().min(0),
    address: nullableText(500),
    coordinates: z.object({ latitude: z.number(), longitude: z.number() }).strict().nullable(),
    timezone: z.string(),
    metro: z
      .object({ name: z.string(), distanceMeters: z.number().int().nonnegative().nullable() })
      .strict()
      .nullable(),
    phoneE164: z.string().nullable(),
    gallery: z.array(locationGalleryImageSchema).max(12),
    amenities: z.array(locationAmenitySchema).max(16),
    workingHours: locationWeeklyHoursSchema,
    openNow: z.boolean(),
    workingHoursSummary: z.string().min(1).max(160),
    navigationUrl: z.string().url().nullable(),
    route: publicRoute,
  })
  .strict();
export type LocationDetail = z.infer<typeof locationDetailSchema>;

const REQUIRED_COMPLETENESS_FIELDS = [
  'cover',
  'city',
  'courts',
  'address',
  'coordinates',
  'phone',
  'working_hours',
] as const;

export function locationCompleteness(input: LocationProfileInput): LocationCompleteness {
  const missingFields: LocationCompleteness['missingFields'][number][] = [];
  if (!input.gallery.some((image) => image.isCover)) missingFields.push('cover');
  if (!input.city) missingFields.push('city');
  if (input.courtCount < 1) missingFields.push('courts');
  if (!input.address) missingFields.push('address');
  if (input.latitude === null || input.longitude === null) missingFields.push('coordinates');
  if (!input.phoneE164) missingFields.push('phone');
  if (input.workingHours.length !== 7) missingFields.push('working_hours');
  const completed = REQUIRED_COMPLETENESS_FIELDS.length - missingFields.length;
  return {
    percent: Math.round((completed / REQUIRED_COMPLETENESS_FIELDS.length) * 100),
    readyToPublish: missingFields.length === 0,
    missingFields,
  };
}

function coverImage(input: Pick<LocationProfileInput, 'gallery'>): string | null {
  return input.gallery.find((image) => image.isCover)?.url ?? null;
}

export function buildLocationSummary(input: LocationAdminView): LocationSummary {
  return locationSummarySchema.parse({
    id: input.id,
    title: input.shortTitle ?? input.title,
    city: input.city,
    courtCount: input.courtCount,
    coverImageUrl: coverImage(input),
    route: `/locations/${input.id}`,
  });
}

const WEEKDAY_FROM_SHORT: Readonly<Record<string, LocationWeekday>> = {
  Mon: 'MON',
  Tue: 'TUE',
  Wed: 'WED',
  Thu: 'THU',
  Fri: 'FRI',
  Sat: 'SAT',
  Sun: 'SUN',
};

function localClock(now: Date, timezone: string): { weekday: LocationWeekday; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const weekday = WEEKDAY_FROM_SHORT[parts.find((part) => part.type === 'weekday')?.value ?? ''];
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? Number.NaN);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? Number.NaN);
  if (!weekday || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error('LOCATION_TIMEZONE_INVALID');
  }
  return { weekday, minute: hour * 60 + minute };
}

function timeMinute(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function intervalContains(minute: number, opensAt: string, closesAt: string): boolean {
  const opens = timeMinute(opensAt);
  const closes = timeMinute(closesAt);
  return closes > opens ? minute >= opens && minute < closes : minute >= opens || minute < closes;
}

function scheduleStatus(
  input: LocationAdminView,
  now: Date,
): { openNow: boolean; summary: string } {
  const local = localClock(now, input.timezone);
  const today = input.workingHours.find((entry) => entry.weekday === local.weekday);
  const weekdayOrder = locationWeekdaySchema.options;
  const todayIndex = weekdayOrder.indexOf(local.weekday);
  const previousWeekday =
    weekdayOrder[(todayIndex + weekdayOrder.length - 1) % weekdayOrder.length];
  const previousDay = input.workingHours.find((entry) => entry.weekday === previousWeekday);
  const previousOvernight = previousDay?.closed
    ? undefined
    : previousDay?.intervals.find(
        (interval) =>
          timeMinute(interval.closesAt) < timeMinute(interval.opensAt) &&
          local.minute < timeMinute(interval.closesAt),
      );
  if (previousOvernight) {
    return { openNow: true, summary: `Открыто до ${previousOvernight.closesAt}` };
  }
  if (!today || today.closed || today.intervals.length === 0) {
    return { openNow: false, summary: 'Сегодня закрыто' };
  }
  const openNow = today.intervals.some((interval) =>
    intervalContains(local.minute, interval.opensAt, interval.closesAt),
  );
  const intervalText = today.intervals
    .map((interval) => `${interval.opensAt}—${interval.closesAt}`)
    .join(', ');
  const allDaysEqual =
    input.workingHours.length === 7 &&
    input.workingHours.every(
      (entry) =>
        !entry.closed && JSON.stringify(entry.intervals) === JSON.stringify(today.intervals),
    );
  return { openNow, summary: `${allDaysEqual ? 'Ежедневно' : 'Сегодня'}, ${intervalText}` };
}

export function buildLocationDetail(input: LocationAdminView, now = new Date()): LocationDetail {
  const status = scheduleStatus(input, now);
  const hasCoordinates = input.latitude !== null && input.longitude !== null;
  return locationDetailSchema.parse({
    id: input.id,
    slug: input.slug,
    title: input.title,
    shortTitle: input.shortTitle,
    city: input.city,
    courtCount: input.courtCount,
    address: input.address,
    coordinates: hasCoordinates ? { latitude: input.latitude, longitude: input.longitude } : null,
    timezone: input.timezone,
    metro: input.metroName
      ? { name: input.metroName, distanceMeters: input.metroDistanceMeters }
      : null,
    phoneE164: input.phoneE164,
    gallery: [...input.gallery].sort((left, right) => left.sortOrder - right.sortOrder),
    amenities: [...input.amenities].sort((left, right) => left.sortOrder - right.sortOrder),
    workingHours: input.workingHours,
    openNow: status.openNow,
    workingHoursSummary: status.summary,
    navigationUrl: hasCoordinates
      ? `https://yandex.ru/maps/?rtext=~${input.latitude},${input.longitude}&rtt=auto`
      : null,
    route: `/locations/${input.id}`,
  });
}

export const LOCATION_PROFILE_CHANGED_EVENT = 'locations.profile.changed.v1';

export const locationProfileChangedEventSchema = z
  .object({
    id: uuid,
    type: z.literal(LOCATION_PROFILE_CHANGED_EVENT),
    aggregateId: uuid,
    tenantId: uuid,
    occurredAt: dateTime,
    correlationId: z.string().min(8).max(128),
    payload: z
      .object({
        locationId: uuid,
        componentRevision: z.string().regex(/^[1-9]\d*$/),
      })
      .strict(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.aggregateId !== event.payload.locationId) {
      context.addIssue({
        code: 'custom',
        path: ['aggregateId'],
        message: 'aggregateId must match locationId',
      });
    }
  });
export type LocationProfileChangedEvent = z.infer<typeof locationProfileChangedEventSchema>;

export function slugifyLocationTitle(value: string): string {
  const transliteration: Readonly<Record<string, string>> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'c',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ы: 'y',
    э: 'e',
    ю: 'yu',
    я: 'ya',
    ъ: '',
    ь: '',
  };
  return [...value.toLocaleLowerCase('ru-RU')]
    .map((character) => transliteration[character] ?? character)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 79);
}
