import { NotFoundError } from '../utils/errors';
import type { AggregateRepository, AnyAggregateEvent, BaseState, EventsRepository } from './types';

export type Role = 'creator' | 'updater';
export type Account = { id: string; roles: Role[] };

export const createId = () => Math.random().toString(36).slice(2);

export const fakeAuthAdapter = {
  getAccount: async (): Promise<Account | null> => ({
    id: 'account1',
    roles: ['creator', 'updater'],
  }),
  getDeviceId: async () => 'device1',
};

export const createFakeEventsRepository = (): EventsRepository & {
  events: AnyAggregateEvent[];
} => {
  let events: AnyAggregateEvent[] = [];
  return {
    get events() {
      return events;
    },
    insert: async (event: AnyAggregateEvent) => {
      events.push(event);
    },
    reset: async () => {
      events = [];
    },
    markRecorded: async (eventId: string, recordedAt: Date, recordedBy: string) => {
      const event = events.find((e) => e.id === eventId);
      if (!event) throw new NotFoundError(`Event ${eventId} not found`);
      event.recordedAt = recordedAt;
      event.createdBy = recordedBy;
    },
    getUnrecorded: async () => events.filter((e) => !e.recordedAt),
    getLastRecordedEvent: async () => {
      const recordedEvents = events.filter((e) => !e.recordedAt);
      if (recordedEvents.length === 0) return null;
      return recordedEvents[recordedEvents.length - 1];
    },
  };
};

export const createFakeAggregateRepository = <S extends BaseState>(): AggregateRepository<S> => {
  const storage: { [id: string]: S } = {};
  return {
    getOne: async (id: string) => storage[id],
    getAll: async () => storage,
    insert: async (id: string, state: S) => {
      storage[id] = state;
    },
    update: async (id: string, state: S) => {
      storage[id] = state;
    },
    delete: async (id: string) => {
      delete storage[id];
    },
    deleteAll: async () => {
      Object.keys(storage).forEach((id) => {
        delete storage[id];
      });
    },
  };
};
