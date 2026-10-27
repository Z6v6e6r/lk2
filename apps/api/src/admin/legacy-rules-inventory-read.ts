import { z } from 'zod';

import { LEGACY_RULES_INVENTORY } from './legacy-rules-inventory.js';

/**
 * Read-only intake view of the LK1 active-rule inventory. The values are evidence for the
 * operator, not runtime authority: CUP publishes the rules and LK2 evaluates only its own copy at
 * write time. A malformed snapshot is reported as unavailable, never as an empty rule set.
 */
const inventorySchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().min(1),
  repo: z.object({
    url: z.string().min(1),
    sha: z.string().min(1),
    date: z.string().min(1),
  }),
  products: z.array(
    z.object({
      productId: z.string().min(1),
      name: z.string().min(1),
      status: z.string().min(1),
      aliases: z.array(z.string()).optional(),
      vivaProductIds: z.array(z.string()).optional(),
      stations: z.array(z.string()).optional(),
      sources: z.array(z.unknown()).optional(),
    }),
  ),
  rules: z.array(
    z.object({
      ruleId: z.string().min(1),
      productId: z.string().min(1),
      ruleGroup: z.string().min(1),
      value: z.unknown(),
      status: z.string().min(1),
      confidence: z.string().optional(),
      service: z.string().optional(),
      action: z.string().optional(),
      appliesTo: z.string().optional(),
      unit: z.unknown().optional(),
      period: z.unknown().optional(),
      exceptions: z.array(z.unknown()).optional(),
      onViolation: z.string().optional(),
      effectiveFrom: z.string().nullable().optional(),
      effectiveTo: z.string().nullable().optional(),
      evidence: z.array(z.unknown()).optional(),
      notes: z.string().optional(),
    }),
  ),
  conflicts: z.array(z.unknown()),
  gaps: z.array(z.unknown()),
});

export type LegacyRulesInventory = z.infer<typeof inventorySchema>;

let cached: LegacyRulesInventory | null | undefined;

export function readLegacyRulesInventory(): LegacyRulesInventory | null {
  if (cached !== undefined) return cached;
  const parsed = inventorySchema.safeParse(LEGACY_RULES_INVENTORY);
  cached = parsed.success ? parsed.data : null;
  return cached;
}

export type LegacyRulesInventorySummary =
  | {
      readonly source: 'LK1_INVENTORY';
      readonly status: 'OK';
      readonly authority: 'INVENTORY_ONLY';
      readonly asOf: string;
      readonly repo: { readonly url: string; readonly sha: string; readonly date: string };
      readonly products: number;
      readonly rules: number;
      readonly conflicts: number;
      readonly gaps: number;
    }
  | {
      readonly source: 'LK1_INVENTORY';
      readonly status: 'UNAVAILABLE';
      readonly reason: 'LEGACY_RULES_INVENTORY_INVALID';
    };

export function legacyRulesInventorySummary(): LegacyRulesInventorySummary {
  const inventory = readLegacyRulesInventory();
  if (!inventory) {
    return {
      source: 'LK1_INVENTORY',
      status: 'UNAVAILABLE',
      reason: 'LEGACY_RULES_INVENTORY_INVALID',
    };
  }
  return {
    source: 'LK1_INVENTORY',
    status: 'OK',
    authority: 'INVENTORY_ONLY',
    asOf: inventory.generatedAt,
    repo: inventory.repo,
    products: inventory.products.length,
    rules: inventory.rules.length,
    conflicts: inventory.conflicts.length,
    gaps: inventory.gaps.length,
  };
}
