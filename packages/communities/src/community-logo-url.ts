import { COMMUNITY_LOGO_DELIVERY_PATH_PATTERN } from '@phub/domain';
import { z } from 'zod';

export const communityLogoUrlSchema = z
  .string()
  .max(2_048)
  .refine(
    (value) =>
      z.string().url().safeParse(value).success || COMMUNITY_LOGO_DELIVERY_PATH_PATTERN.test(value),
    'logo URL must be absolute or use the PadlHub community-logo delivery endpoint',
  );
