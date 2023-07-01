import { z, ZodError } from 'zod';
import { createBroker, AggregateEvent } from '.';
import { InvalidInputError, NotFoundError, StorageError, UnauthorizedError } from './utils/errors';

describe('event sync', () => {
  // Given an id creator
  const createId = () => Math.random().toString(36).slice(2);
  // And an event schema
  const baseEventSchema = z.object({
    id: z.string(),
    dispatchedAt: z.date(),
    createdBy: z.string().optional(),
    createdOn: z.string().optional(),
    aggregateId: z.string(),
  });
  const aggregateSchema = z.object({
    id: z.string(),
    name: z.string().min(2),
    value: z.string(),
    lastEventId: z.string(),
    createdBy: z.string().optional(),
    likes: z.number().default(0),
  });
  const eventSchema = z.discriminatedUnion('type', [
    baseEventSchema.extend({
      aggregateType: z.literal('test'),
      type: z.literal('CREATED_TEST_AGGREGATE'),
      payload: aggregateSchema
        .omit({ id: true, lastEventId: true, createdBy: true })
        .partial({ likes: true }),
    }),
    baseEventSchema.extend({
      prevId: z.string(),
      aggregateType: z.literal('test'),
      type: z.literal('UPDATED_TEST_AGGREGATE'),
      payload: aggregateSchema.omit({ id: true, lastEventId: true, createdBy: true }).partial(),
    }),
    baseEventSchema.extend({
      prevId: z.string(),
      aggregateType: z.literal('test'),
      type: z.literal('LIKED_TEST_AGGREGATE'),
      payload: z.object({}),
    }),
  ]);
  // And an aggregate reducer
  type Aggregate = z.infer<typeof aggregateSchema>;
  type TestState = Record<string, Aggregate>;
  type TestEvent = z.infer<typeof eventSchema>;
  const reducer = (state: TestState, event: TestEvent): TestState => {
    switch (event.type) {
      case 'CREATED_TEST_AGGREGATE':
        return {
          ...state,
          [event.aggregateId]: {
            ...event.payload,
            id: event.aggregateId,
            createdBy: event.createdBy,
            lastEventId: event.id,
            likes: 0,
          },
        };
      case 'UPDATED_TEST_AGGREGATE':
        if (!(event.aggregateId in state)) throw new InvalidInputError('Invalid aggregate id');
        return {
          ...state,
          [event.aggregateId]: {
            ...state[event.aggregateId],
            ...event.payload,
            lastEventId: event.id,
          },
        };
      case 'LIKED_TEST_AGGREGATE':
        if (!(event.aggregateId in state)) throw new InvalidInputError('Invalid aggregate id');
        return {
          ...state,
          [event.aggregateId]: {
            ...state[event.aggregateId],
            lastEventId: event.id,
          },
        };
    }
  };
  // And an aggregate authorizer
  type Role = 'creator' | 'updater';
  const authorizer = (
    event: TestEvent,
    account?: { id: string; roles: Role[] } | null
  ): boolean => {
    switch (event.type) {
      case 'CREATED_TEST_AGGREGATE':
        if (event.createdBy !== account?.id) return false;
        return account?.roles.includes('creator') || false;
      case 'UPDATED_TEST_AGGREGATE':
        if (event.createdBy !== account?.id) return false;
        return account?.roles.includes('updater') || false;
      case 'LIKED_TEST_AGGREGATE':
        return true;
    }
  };
  // And an aggregate repository
  const repository = {
    storage: {} as TestState,
    async get() {
      return this.storage;
    },
    async set(state: TestState) {
      this.storage = state;
    },
    async reset() {
      this.storage = {};
      return this.storage;
    },
  };
  // And an event broker
  const eventsRepository = {
    storage: [] as AggregateEvent<any>[],
    async insert(event: AggregateEvent<any>) {
      this.storage.push(event);
    },
    async reset() {
      this.storage = [];
    },
    async markRecorded(eventId: string, recordedAt: Date, recordedBy: string) {
      const event = this.storage.find((e) => e.id === eventId);
      if (!event) throw new NotFoundError(`Event ${eventId} not found`);
      event.recordedAt = recordedAt;
      event.createdBy = recordedBy;
    },
    async getUnrecorded() {
      return this.storage.filter((e) => !e.recordedAt);
    },
    async getLastRecordedEvent() {
      const recordedEvents = this.storage.filter((e) => !e.recordedAt);
      if (recordedEvents.length === 0) return null;
      return recordedEvents[recordedEvents.length - 1];
    },
  };
  const eventServerAdapter = {
    subscriber: (event: AggregateEvent<any>) => {},
    async record(event: AggregateEvent<any>) {
      return {
        eventId: event.id,
        recordedAt: new Date(),
        recordedBy: (await authAdapter.getAccount())!.id,
      };
    },
    async fetch(lastRecordedEventId: string | null): Promise<AggregateEvent<any>[]> {
      return [];
    },
    subscribe(subscriber: (event: AggregateEvent<any>) => void) {
      this.subscriber = subscriber;
      return () => {
        this.subscriber = () => {};
      };
    },
  };
  const connectionStatusAdapter = {
    listener: (status: boolean) => {},
    async check() {
      return true;
    },
    async listen(callback: (status: boolean) => void) {
      this.listener = callback;
    },
  };

  const authAdapter = {
    getAccount: async (): Promise<{ id: string; roles: Role[] } | null> => ({
      id: 'account1',
      roles: ['creator'],
    }),
    getDeviceId: async () => 'device1',
    loginCallbacks: [] as (() => void)[],
    onLogin(callback: () => void) {
      this.loginCallbacks.push(callback);
    },
    logoutCallbacks: [] as (() => void)[],
    onLogout(callback: () => void) {
      this.logoutCallbacks.push(callback);
    },
  };

  const broker = createBroker({
    eventsRepository,
    eventServerAdapter,
    connectionStatusAdapter,
    retrySyncInterval: 100,
    authAdapter,
    createId,
  });

  let store: ReturnType<typeof broker.registerStore<'test', TestState, TestEvent>>;
  beforeEach(async () => {
    store = broker.registerStore('test', {
      reducer,
      authorizer,
      repository,
      parseEvent: eventSchema.parse,
      selectLastEventId: (state, aggregateId) => state[aggregateId]?.lastEventId,
    });
  });
  afterEach(async () => {
    await store.destroy();
    eventsRepository.storage = [];
    repository.storage = {};
    jest.restoreAllMocks();
    jest.resetAllMocks();
  });
  afterAll(() => {
    broker.cleanup();
  });

  it('Starts up first time with initial state', async () => {
    // When the current state is queried
    const state = await store.get();
    // Then the initial state is returned
    expect(state).toEqual({});
  });

  it('Can update state', async () => {
    // Given two subscribers to the aggregate state
    const subscriber1 = jest.fn();
    const subscriber2 = jest.fn();
    store.subscribe(subscriber1);
    store.subscribe(subscriber2);
    // When an authorized aggregate event is dispatched
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'first value',
    });
    // Then both subscribers are called with the new state
    const expectedNewState = {
      testAggregateId: {
        name: 'my aggregate',
        value: 'first value',
        likes: 0,
        id: 'testAggregateId',
        createdBy: 'account1',
        lastEventId: expect.any(String),
      },
    };
    expect(subscriber1).toHaveBeenCalledWith(expectedNewState);
    expect(subscriber2).toHaveBeenCalledWith(expectedNewState);
    // And the new state can be queried
    const state = await store.get();
    expect(state).toEqual(expectedNewState);
  });

  it('Verifies event schema', async () => {
    expect.assertions(4);
    const currentState = await store.get();
    const subscriber = jest.fn();
    await store.subscribe(subscriber);
    subscriber.mockReset();
    try {
      // When an event is dispatched with an invalid payload
      await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
        name: '',
        value: 'first value',
      });
    } catch (e) {
      // Then an invalid input error is thrown
      expect(e).toBeInstanceOf(InvalidInputError);
      expect((e as InvalidInputError<ZodError>).cause?.issues[0]).toEqual(
        expect.objectContaining({ code: 'too_small', path: ['payload', 'name'] })
      );
    } finally {
      // And the state is not updated
      expect(await store.get()).toEqual(currentState);
      expect(subscriber).not.toHaveBeenCalled();
    }
  });

  it('Checks authorization for event', async () => {
    expect.assertions(4);
    // Given an aggregate has been created
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'new value',
    });
    // And a subscriber to the aggregate state
    const currentState = await store.get();
    const subscriber = jest.fn();
    await store.subscribe(subscriber);
    subscriber.mockReset();
    try {
      // When an update event is dispatched for which the account is not authorized
      await store.dispatch('testAggregateId', 'UPDATED_TEST_AGGREGATE', { value: 'new value' });
    } catch (e) {
      // Then an authorization error is thrown
      expect(e).toBeInstanceOf(UnauthorizedError);
      expect((e as UnauthorizedError).message).toContain('not authorized');
    } finally {
      // And the state is not updated
      expect(await store.get()).toEqual(currentState);
      expect(subscriber).not.toHaveBeenCalled();
    }
  });

  it('Store can be destroyed', async () => {
    // Given a few events were dispatched
    await store.dispatch('testAggregateId1', 'CREATED_TEST_AGGREGATE', {
      name: 'aggregate 1',
      value: 'value 1',
    });
    await store.dispatch('testAggregateId2', 'CREATED_TEST_AGGREGATE', {
      name: 'aggregate 2',
      value: 'value 2',
    });
    expect(Object.entries(await store.get())).toHaveLength(2);
    // And there is a subscriber to the aggregate state
    const subscriber1 = jest.fn();
    await store.subscribe(subscriber1);
    subscriber1.mockReset();
    // When the store is destroyed
    await store.destroy();
    // Then the state cannot be queried anymore
    await expect(store.get()).rejects.toThrowError();
    // And the subscribers are not called again
    expect(subscriber1).not.toHaveBeenCalled();
    // And new events cannot be dispatched
    await expect(
      store.dispatch('testAggregateId1', 'CREATED_TEST_AGGREGATE', {
        name: 'aggregate 1',
        value: 'value 1',
      })
    ).rejects.toThrowError();
    // And new subscribers cannot be added
    await expect(() => store.subscribe(jest.fn())).rejects.toThrowError();
  });

  it('Persists events', async () => {
    // When an event is dispatched
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'first value',
    });
    // Then it is stored
    expect(eventsRepository.storage).toHaveLength(1);
    expect(eventsRepository.storage[0]).toEqual(
      expect.objectContaining({
        aggregateId: 'testAggregateId',
        type: 'CREATED_TEST_AGGREGATE',
        payload: { name: 'my aggregate', value: 'first value' },
      })
    );
  });

  it('Adds metadata to event', async () => {
    // When an event is dispatched
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'first value',
    });
    jest
      .spyOn(authAdapter, 'getAccount')
      .mockImplementation(async () => ({ id: 'account1', roles: ['creator', 'updater'] }));
    await store.dispatch('testAggregateId', 'UPDATED_TEST_AGGREGATE', {
      value: 'second value',
    });
    const storedEvents = eventsRepository.storage;
    expect(storedEvents).toHaveLength(2);
    const storedEvent = storedEvents[1];
    // Then the stored event has an id attached
    expect(storedEvent.id).toEqual(expect.any(String));
    // And the correct aggregate type is attached
    expect(storedEvent.aggregateType).toEqual('test');
    // And the correct deviceId is attached
    expect(storedEvent.createdOn).toEqual('device1');
    // And the correct accountId is attached*
    expect(storedEvent.createdBy).toEqual('account1');
    // And the correct time stamp is attached
    expect(storedEvent.dispatchedAt).toEqual(expect.any(Date));
    expect(Date.now() - storedEvent.dispatchedAt.getTime()).toBeLessThan(1000);
    // And the correct previous event id is attached
    expect(storedEvent.prevId).toEqual(storedEvents[0].id);
  });

  it('Doesn’t update state if event can’t be persisted', async () => {
    // Given something goes wrong during storage for some reason
    jest.spyOn(eventsRepository, 'insert').mockImplementationOnce(async () => {
      throw new Error("something wen't wrong");
    });
    try {
      // When an event was dispatched
      await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
        name: 'my aggregate',
        value: 'first value',
      });
    } catch (e) {
      // Then a storage error is thrown
      expect(e).toBeInstanceOf(StorageError);
      expect((e as StorageError).cause.message).toContain("something wen't wrong");
    } finally {
      // And the state is not updated
      expect(await store.get()).toEqual({});
    }
  });

  it('Persists current state in repository', async () => {
    // When an event is dispatched
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'first value',
    });
    // Then the state current state is persisted
    const currentState = await store.get();
    expect(await repository.get()).toEqual(currentState);
  });

  it('Starts up with state persisted to repository', async () => {
    // Given a repository with a persisted state
    repository.storage = {
      testAggregateId: {
        id: 'testAggregateId',
        name: 'my aggregate',
        value: 'first value',
        likes: 0,
        createdBy: 'account1',
        lastEventId: 'event1',
      },
    };
    // And a fresh store instance
    await store.destroy();
    store = broker.registerStore('test', {
      reducer,
      authorizer,
      repository,
      parseEvent: eventSchema.parse,
      selectLastEventId: (state, aggregateId) => state[aggregateId]?.lastEventId,
    });
    // When the current state is queried after a restart
    const currentState = await store.get();
    // Then the state reflects the previously persisted state
    expect(currentState).toEqual(repository.storage);
  });

  it('Events are synced', async () => {
    // Given the device is online and the user has an account
    let eventId: string, recordedAt: Date;
    jest.spyOn(eventServerAdapter, 'record').mockImplementationOnce(async (event) => {
      eventId = event.id;
      recordedAt = new Date();
      return { eventId, recordedAt, recordedBy: (await authAdapter.getAccount())!.id };
    });
    // When an event is dispatched
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'first value',
    });
    // And the event has been processed
    await new Promise((resolve) => setTimeout(resolve));
    // Then it is recorded with the event sync adapter
    expect(eventServerAdapter.record).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateType: 'test',
        type: 'CREATED_TEST_AGGREGATE',
        payload: { name: 'my aggregate', value: 'first value' },
      })
    );
    // And when saving succeeds, the recorded time is stored in the persisted event
    const updatedEvent = eventsRepository.storage.find((e) => e.id === eventId);
    expect(updatedEvent?.recordedAt).toEqual(recordedAt!);
  });

  it('If device comes back online previously dispatched events are synced', async () => {
    // Given events where dispatched while the device was offline
    jest.spyOn(eventServerAdapter, 'record').mockImplementation(async (event) => {
      throw new Error('network not available');
    });
    jest
      .spyOn(authAdapter, 'getAccount')
      .mockImplementation(async () => ({ id: 'account1', roles: ['creator', 'updater'] }));
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'first value',
    });
    await store.dispatch('testAggregateId', 'UPDATED_TEST_AGGREGATE', {
      value: 'second value',
    });
    expect(eventsRepository.storage.map((e) => e.recordedAt)).toEqual([undefined, undefined]);
    // When the device comes back online
    jest.spyOn(eventServerAdapter, 'record').mockRestore();
    jest.spyOn(eventServerAdapter, 'record');
    connectionStatusAdapter.listener(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Then the events are sent to the backend
    expect(eventServerAdapter.record).toHaveBeenCalledTimes(2);
    // And the events are marked as recorded
    expect(eventsRepository.storage).toContainEqual(
      expect.objectContaining({ recordedAt: expect.any(Date) })
    );
  });

  it('Periodically retries syncing failed events', async () => {
    // Given events where dispatched while the device was offline
    jest.spyOn(eventServerAdapter, 'record').mockImplementation(async (event) => {
      throw new Error('network not available');
    });
    jest
      .spyOn(authAdapter, 'getAccount')
      .mockImplementation(async () => ({ id: 'account1', roles: ['creator', 'updater'] }));
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'first value',
    });
    await store.dispatch('testAggregateId', 'UPDATED_TEST_AGGREGATE', {
      value: 'second value',
    });
    expect(eventsRepository.storage.map((e) => e.recordedAt)).toEqual([undefined, undefined]);
    // When the device comes back online but the sync still fails
    await new Promise((resolve) => setTimeout(resolve));
    // Then it retries after a while
    jest.spyOn(eventServerAdapter, 'record').mockRestore();
    jest.spyOn(eventServerAdapter, 'record');
    await new Promise((resolve) => setTimeout(resolve, 200));
    // And the events are sent to the backend
    expect(eventServerAdapter.record).toHaveBeenCalledTimes(2);
    // And the events are marked as recorded
    expect(eventsRepository.storage).toContainEqual(
      expect.objectContaining({ recordedAt: expect.any(Date) })
    );
  });

  it('Works without account', async () => {
    // Given an aggregate was created
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'first value',
    });
    jest.spyOn(eventServerAdapter, 'record').mockClear();
    // And there is no account setup on the device
    jest.spyOn(authAdapter, 'getAccount').mockImplementation(async () => null);
    // When an action is dispatched
    await store.dispatch('testAggregateId', 'LIKED_TEST_AGGREGATE', {});
    // Then it is saved without a created by
    expect(eventsRepository.storage).toContainEqual(
      expect.objectContaining({ createdBy: undefined })
    );
    // And the events are not send to the backend
    expect(eventServerAdapter.record).not.toHaveBeenCalled();
  });

  it('Saved events are transmitted once the device logs into an account', async () => {
    // Given an aggregate was created
    jest.spyOn(eventServerAdapter, 'record');
    jest
      .spyOn(authAdapter, 'getAccount')
      .mockImplementation(async () => ({ id: 'account1', roles: ['creator'] }));
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'first value',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(eventServerAdapter.record).toHaveBeenCalledTimes(1);
    jest.spyOn(eventServerAdapter, 'record').mockClear();
    // And there is no account setup on the device
    jest.spyOn(authAdapter, 'getAccount').mockImplementation(async () => null);
    // And there are events that were dispatched
    await store.dispatch('testAggregateId', 'LIKED_TEST_AGGREGATE', {});
    await store.dispatch('testAggregateId', 'LIKED_TEST_AGGREGATE', {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      eventsRepository.storage.filter((e) => e.type === 'LIKED_TEST_AGGREGATE' && e.recordedAt)
    ).toHaveLength(0);
    // When an account is created
    jest
      .spyOn(authAdapter, 'getAccount')
      .mockImplementation(async () => ({ id: 'account2', roles: [] }));
    authAdapter.loginCallbacks.forEach((cb) => cb());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Then the events are synced to the backend
    expect(eventServerAdapter.record).toHaveBeenCalledTimes(2);
    // And the events are marked as recorded
    expect(
      eventsRepository.storage.filter((e) => e.type === 'LIKED_TEST_AGGREGATE' && e.recordedAt)
    ).toHaveLength(2);
    // And the events are marked as created by the account
    expect(eventsRepository.storage).toContainEqual(
      expect.objectContaining({
        type: 'LIKED_TEST_AGGREGATE',
        createdBy: 'account2',
      })
    );
  });

  it('Clears up event queue when the device logs out', async () => {
    // Given events were recorded on a logged in device
    await store.dispatch('testAggregateId', 'CREATED_TEST_AGGREGATE', {
      name: 'my aggregate',
      value: 'first value',
    });
    expect(await store.get()).toEqual({
      testAggregateId: expect.objectContaining({ name: 'my aggregate', value: 'first value' }),
    });
    // And there is a subscriber to the store
    const subscriber = jest.fn();
    store.subscribe(subscriber);
    // When the device logs out
    jest.spyOn(authAdapter, 'getAccount').mockImplementation(async () => null);
    authAdapter.logoutCallbacks.forEach((cb) => cb());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Then the store state is reset
    expect(await store.get()).toEqual({});
    // And all subscribers are notified
    expect(subscriber).toHaveBeenCalledWith({});
    // And the events are deleted from the repository
    expect(eventsRepository.storage).toHaveLength(0);
  });

  it('Syncs available events at startup', async () => {
    // Given there are new events available from the backend
    jest.spyOn(eventServerAdapter, 'fetch').mockImplementation(async () => [
      {
        id: createId(),
        aggregateType: 'test',
        aggregateId: 'serverTestAggregateId',
        type: 'CREATED_TEST_AGGREGATE',
        payload: { name: 'server aggregate', value: 'server value' },
        dispatchedAt: new Date(),
        recordedAt: new Date(),
        createdBy: 'server account',
      },
    ]);
    // When the app starts up
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Then all events after the latest event not recorded are fetched from the backend
    expect(eventServerAdapter.fetch).toHaveBeenCalledWith(null);
    // And the store state is updated
    expect(await store.get()).toEqual({
      serverTestAggregateId: expect.objectContaining({
        name: 'server aggregate',
        value: 'server value',
      }),
    });
  });

  it('Subscribes to new events happening on other devices', async () => {
    // When there are new events dispatched on the server
    eventServerAdapter.subscriber({
      id: createId(),
      aggregateType: 'test',
      aggregateId: 'serverTestAggregateId',
      type: 'CREATED_TEST_AGGREGATE',
      payload: { name: 'server aggregate', value: 'server value' },
      dispatchedAt: new Date(),
      recordedAt: new Date(),
      createdBy: 'server account',
    });
    // Then the state is updated in the store
    expect(await store.get()).toEqual({
      serverTestAggregateId: expect.objectContaining({
        name: 'server aggregate',
        value: 'server value',
      }),
    });
  });

  it.skip('Events are applied in order of dispatch', async () => {
    // Given there are new events available from the backend that happened before events recorded on the current device
    // When the events are synced
    // Then the state is recomputed by applying all events for an aggregate in dispatch order
  });
});
