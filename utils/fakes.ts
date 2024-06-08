import { NotFoundError, UnauthorizedError } from '../utils/errors';
import type {
  AggregateEvent,
  AggregateRepository,
  AnyAggregateEvent,
  AnyRecordedAggregateEvent,
  AuthAdapter,
  BaseState,
  ConnectionStatusAdapter,
  EventServerAdapter,
  EventsRepository,
  Operation,
} from './types';

export type Role = 'creator' | 'updater';
export type Account = { id: string; roles: Role[] };

/**
 * Generates a random string ID based on Math.random
 *
 * @returns A random string ID.
 */
export const createId = () => Math.random().toString(36).slice(2, 14).padEnd(12, '0');

/**
 * Fake auth adapter that always returns account id 'account1' with roles 'creator' and 'updater'
 * and device id 'device1'
 */
export const createFakeAuthAdapter = (): AuthAdapter<Account> => {
  const accountId = createId();
  const deviceId = createId();
  return {
    getAccount: async (): Promise<Account | null> => ({
      id: accountId,
      roles: ['creator', 'updater'],
    }),
    getDeviceId: async () => deviceId,
  };
};

/**
 * Creates a fake events repository for testing purposes.
 *
 * @returns An object that implements the EventsRepository interface and also has an `events`
 * property that contains all the events in the repository
 */
export const createFakeEventsRepository = (
  authAdapter: AuthAdapter<Account> = createFakeAuthAdapter(),
): EventsRepository & {
  events: AnyAggregateEvent[];
} => {
  let events: AnyAggregateEvent[] = [];
  return {
    get events() {
      return events;
    },
    create: async (event: AnyAggregateEvent) => {
      if (events.find((e) => e.id === event.id)) {
        throw new Error(`Event ${event.id} already exists`);
      }
      events.push(event);
    },
    deleteAll: async () => {
      events = [];
    },
    markRecorded: async (eventId: string, update: { recordedAt: Date; createdBy: string }) => {
      const event = events.find((e) => e.id === eventId);
      if (!event) throw new NotFoundError(`event:${eventId} not found`);
      event.recordedAt = update.recordedAt;
      event.createdBy = update.createdBy;
    },
    getUnrecorded: async () => events.filter((e) => !e.recordedAt),
    getLastReceivedEvent: async () => {
      const deviceId = await authAdapter.getDeviceId();
      const receivedEvents = events
        .filter((e) => e.recordedAt && e.createdOn !== deviceId)
        .sort((a, b) => a.recordedAt!.getTime() - b.recordedAt!.getTime());
      if (receivedEvents.length === 0) return null;
      return receivedEvents[receivedEvents.length - 1] ?? null;
    },
  };
};

/**
 * Creates a fake event server adapter for testing purposes.
 *
 * @returns An object that implements the EventServerAdapter interface, with additional properties
 * for simulating dispatching events from other sources and getting and setting recorded events
 */
export const createFakeEventServerAdapter = (
  authAdapter: AuthAdapter<Account> = createFakeAuthAdapter(),
): EventServerAdapter & {
  dispatch(event: AnyRecordedAggregateEvent): void;
  recordedEvents: AnyRecordedAggregateEvent[];
} => {
  const subscribers = new Map<string, (event: AnyAggregateEvent) => void>();
  return {
    recordedEvents: [],
    async record(event: AnyAggregateEvent) {
      const account = await authAdapter.getAccount();
      if (!account) throw new UnauthorizedError('Account not found');
      if (event.createdBy && event.createdBy !== account.id) {
        throw new UnauthorizedError('Event created by different account');
      }
      const duplicateEvent = this.recordedEvents.find((e) => e.id === event.id);
      if (duplicateEvent) return duplicateEvent;
      const recordedEvent = {
        ...event,
        recordedAt: new Date(),
        createdBy: event.createdBy ?? account.id,
      };
      this.recordedEvents.push(recordedEvent);
      return recordedEvent;
    },
    async fetch(lastReceivedEventId: string | null): Promise<AnyAggregateEvent[]> {
      const lastEvent = this.recordedEvents.find((e) => e.id === lastReceivedEventId);
      return this.recordedEvents.filter(
        (e) => e.recordedAt > (lastEvent?.recordedAt ?? new Date(0)),
      );
    },
    subscribe(subscriber: (event: AnyAggregateEvent) => void) {
      const id = createId();
      subscribers.set(id, subscriber);
      return () => subscribers.delete(id);
    },
    dispatch(event: AnyRecordedAggregateEvent) {
      this.recordedEvents.push(event);
      subscribers.forEach((subscriber) => subscriber(event));
    },
  };
};

/**
 * Creates a fake aggregate repository with an in-memory storage.
 *
 * @returns An object with methods to get, insert, update, and delete aggregates
 */
export const createFakeAggregateRepository = <S extends BaseState>(): AggregateRepository<S> => {
  const storage: { [id: string]: S } = {};
  return {
    getOne: async (id: string) => storage[id] ?? null,
    getAll: async () => storage,
    create: async (state: S) => {
      storage[state.id] = state;
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

/**
 * Creates an aggregate object with the given state and additional metadata.
 *
 * @param state The initial state of the aggregate object
 * @returns The aggregate object with metadata
 */
export const createAggregateObject = <S extends { id: string }>(state: S): S & BaseState => ({
  createdBy: createId(),
  createdOn: createId(),
  lastEventId: createId(),
  createdAt: new Date(),
  updatedAt: new Date(),
  version: 1,
  ...state,
});

/**
 * Creates an aggregate event with the given aggregate type and event type
 *
 * @param aggregateType The type of the aggregate
 * @param eventType The type of the event
 * @param overwrites An object with properties to overwrite the default values of the event
 * @returns An aggregate event with the given parameters
 */
export const createEvent = <
  A extends string,
  T extends string,
  O extends Operation = 'create',
  P = {},
  R extends Date | undefined = undefined,
  U extends string | undefined = undefined,
>(
  aggregateType: A,
  eventType: T,
  {
    operation = 'create' as O,
    payload = {} as P,
    aggregateId,
    prevId,
    recordedAt,
    createdBy,
    createdOn,
  }: {
    operation?: O;
    payload?: P;
    aggregateId?: string;
    recordedAt?: R;
    createdBy?: U;
    createdOn?: string;
  } & (O extends 'create' ? { prevId?: undefined } : { prevId: string }) = {} as any,
): AggregateEvent<A, O, T, P> &
  (R extends Date ? { recordedAt: Date } : {}) &
  (U extends string ? { createdBy: string } : {}) =>
  // @ts-ignore -- typescript doesn't understand the ternary type
  ({
    id: createId(),
    operation,
    aggregateType,
    aggregateId: aggregateId ?? createId(),
    type: eventType,
    payload: payload,
    dispatchedAt: new Date(),
    createdBy: createdBy ?? createId(),
    createdOn: createdOn ?? createId(),
    recordedAt: recordedAt,
    prevId: prevId as O extends 'create' ? undefined : string,
  });

/**
 * Creates a fake object that implements the ConnectionStatusAdapter interface plus a set method
 *
 * @returns the fake connection status adapter
 */
export const createFakeConnectionStatusAdapter = (): ConnectionStatusAdapter & {
  set: (status: boolean) => void;
} => {
  const subscribers = new Map<string, (status: boolean) => void>();
  let status = true;
  setTimeout(() => {
    subscribers.forEach((subscriber) => subscriber(status));
  }, 0);
  return {
    get: async () => {
      return status;
    },
    subscribe: (subscriber) => {
      const id = createId();
      subscribers.set(id, subscriber);
      return () => subscribers.delete(id);
    },
    set(s: boolean) {
      status = s;
      subscribers.forEach((subscriber) => subscriber(s));
    },
  };
};
