import { COMMUNITY_LOGO_DELIVERY_PATH_PATTERN } from '@phub/domain';
import { z } from 'zod';

export const communityLogoUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => {
    if (COMMUNITY_LOGO_DELIVERY_PATH_PATTERN.test(value)) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'logo URL must be absolute or use the PadlHub community-logo delivery endpoint');
