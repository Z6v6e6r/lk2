import type { NativeCacheObservation } from './native-api-fetch.js';

export type StaleMobileReads = Readonly<Record<string, number>>;

export function observeMobileCache(
  current: StaleMobileReads,
  observation: NativeCacheObservation,
): StaleMobileReads {
  const next = { ...current };
  if (
    observation.state === 'stale' &&
    observation.savedAt !== undefined &&
    Number.isFinite(observation.savedAt) &&
    observation.savedAt > 0
  ) {
    next[observation.path] = observation.savedAt;
  } else {
    delete next[observation.path];
  }
  return next;
}

/** Commit cache metadata only after the two read models pass SDK parsing/normalization. */
export function createMobileReadState(
  onObservation: (observation: NativeCacheObservation) => void,
  onInvalidated: () => void,
): {
  observe(this: void, observation: NativeCacheObservation): void;
  read<T>(path: string, read: () => Promise<T>): Promise<T>;
} {
  let generation = 0;
  const retained = new Set<string>();
  const observations = new Map<string, NativeCacheObservation>();
  const invalidate = (): void => {
    const hadRetained = retained.size > 0;
    retained.clear();
    observations.clear();
    generation += 1;
    if (hadRetained) onInvalidated();
  };
  return {
    observe(observation) {
      if (observation.invalidate) invalidate();
      else observations.set(observation.path, observation);
    },
    async read(path, read) {
      const started = generation;
      try {
        const value = await read();
        // Do not let an old pending success reach App state after a newer read was denied.
        if (started !== generation) throw new Error('NATIVE_READ_SUPERSEDED');
        retained.add(path);
        const observation = observations.get(path);
        if (observation) onObservation(observation);
        observations.delete(path);
        return value;
      } catch (error) {
        // Includes malformed HTTP 200 bodies rejected after the native transport has returned.
        if (started === generation) {
          if (retained.has(path)) invalidate();
          observations.delete(path);
        }
        throw error;
      }
    },
  };
}
