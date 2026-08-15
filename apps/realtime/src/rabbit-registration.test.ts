import { describe, expect, it, vi } from 'vitest';

import { registerRabbitConsumersAtomically } from './rabbit-registration.js';

describe('Rabbit consumer registration generation', () => {
  it('cannot restore readiness after messaging consumer cancellation during registration', async () => {
    let active = true;
    const registerCommunity = vi.fn();
    const markReady = vi.fn();

    await expect(
      registerRabbitConsumersAtomically({
        registerMessaging: () => {
          active = false;
          return Promise.resolve();
        },
        registerCommunity,
        isGenerationActive: () => active,
        markReady,
      }),
    ).rejects.toThrow('RABBITMQ_CONSUMER_INVALIDATED_DURING_REGISTRATION');
    expect(registerCommunity).not.toHaveBeenCalled();
    expect(markReady).not.toHaveBeenCalled();
  });

  it('cannot restore readiness after Communities consumer cancellation during registration', async () => {
    let active = true;
    const markReady = vi.fn();

    await expect(
      registerRabbitConsumersAtomically({
        registerMessaging: () => Promise.resolve(),
        registerCommunity: () => {
          active = false;
          return Promise.resolve();
        },
        isGenerationActive: () => active,
        markReady,
      }),
    ).rejects.toThrow('RABBITMQ_CONSUMER_INVALIDATED_DURING_REGISTRATION');
    expect(markReady).not.toHaveBeenCalled();
  });

  it('marks ready only after every consumer remains active', async () => {
    const markReady = vi.fn();

    await expect(
      registerRabbitConsumersAtomically({
        registerMessaging: () => Promise.resolve(),
        registerCommunity: () => Promise.resolve(),
        isGenerationActive: () => true,
        markReady,
      }),
    ).resolves.toBeUndefined();
    expect(markReady).toHaveBeenCalledOnce();
  });
});
