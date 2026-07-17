import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  GAME_ALLOWED_ACTIONS,
  GAME_CARD_DISPLAY_STATES,
  GAME_KINDS,
  GAME_PLAYER_LEVELS,
  GAME_VISIBILITIES,
} from './index.js';

interface Reference {
  readonly $ref?: string;
}

interface Operation {
  readonly parameters?: readonly Reference[];
  readonly responses?: Readonly<Record<string, unknown>>;
}

interface PathItem {
  readonly parameters?: readonly Reference[];
  readonly get?: Operation;
  readonly post?: Operation;
  readonly put?: Operation;
  readonly patch?: Operation;
  readonly delete?: Operation;
}

interface Schema {
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
}

interface GamesContractDocument {
  readonly paths: Readonly<Record<string, PathItem>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, Schema>>;
  };
}

const contractPath = new URL('../../../contracts/openapi/user/v1/games.yaml', import.meta.url);
const contract = parse(readFileSync(contractPath, 'utf8')) as GamesContractDocument;

describe('authenticated games contract', () => {
  it('keeps card state and action vocabularies aligned with the domain kernel', () => {
    expect(contract.components.schemas.GameCardDisplayState?.enum).toEqual(
      GAME_CARD_DISPLAY_STATES,
    );
    expect(contract.components.schemas.GameAllowedAction?.enum).toEqual(GAME_ALLOWED_ACTIONS);
    expect(contract.components.schemas.GameKind?.enum).toEqual(GAME_KINDS);
    expect(contract.components.schemas.GameVisibility?.enum).toEqual(GAME_VISIBILITIES);
    expect(contract.components.schemas.GamePlayerLevel?.enum).toEqual(GAME_PLAYER_LEVELS);
  });

  it('requires idempotency and a stable conflict response for every command', () => {
    const commandMethods = ['post', 'put', 'patch', 'delete'] as const;
    let commandCount = 0;

    for (const pathItem of Object.values(contract.paths)) {
      for (const method of commandMethods) {
        const operation = pathItem[method];
        if (!operation) continue;
        commandCount += 1;
        const parameterReferences = [
          ...(pathItem.parameters ?? []),
          ...(operation.parameters ?? []),
        ].map((parameter) => parameter.$ref);
        expect(parameterReferences).toContain('#/components/parameters/IdempotencyKey');
        expect(operation.responses).toHaveProperty('409');
      }
    }

    expect(commandCount).toBe(10);
  });

  it('does not accept identity selectors, provider identifiers or caller-owned roster state', () => {
    const requestSchemas = [
      'CreateGameRequest',
      'JoinGameRequest',
      'CancelGameRequest',
      'SubmitGameResultRequest',
      'DisputeGameResultRequest',
    ];
    const forbiddenProperties = [
      'userId',
      'phone',
      'clientId',
      'vivaId',
      'providerId',
      'bookingId',
      'paymentId',
      'source',
      'participants',
      'seatReservations',
      'waitlist',
    ];

    for (const schemaName of requestSchemas) {
      const propertyNames = Object.keys(contract.components.schemas[schemaName]?.properties ?? {});
      expect(propertyNames.filter((property) => forbiddenProperties.includes(property))).toEqual(
        [],
      );
    }
  });

  it('exposes only explicit commands and no generic game patch', () => {
    for (const [path, pathItem] of Object.entries(contract.paths)) {
      expect(pathItem.patch, path).toBeUndefined();
    }
  });
});
