import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/main.ts',
    'src/communities-staged-rehearsal.ts',
    'src/verify-role-boundary.ts',
    'src/verify-media-runtime-role.ts',
    'src/verify-chat-push-foundation.ts',
    'src/verify-chat-push-foundation-operational.ts',
    'src/verify-chat-push-foundation-contour.ts',
    'src/verify-eligibility-payment-acl-boundary.ts',
    'src/provision-eligibility-payment-acl.ts',
    'src/verify-eligibility-payment-runtime-role.ts',
  ],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@phub\//],
});
