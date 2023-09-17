import { ZodError, z } from 'zod';
import { createStore, type AggregateStore } from './store';
import { createEventBus } from './event-bus';
import {
  ConflictError,
  InvalidInputError,
  NetworkError,
  NotFoundError,
  UnauthorizedError,
} from '../utils/errors';
import {
  createId,
  createFakeAuthAdapter,
  createFakeAggregateRepository,
  createFakeEventsRepository,
  createAggregateObject,
  createEvent,
} from '../utils/fakes';
import type {
  AnyAggregateEvent,
  BaseState,
  AggregateRepository,
  AggregateCommandsMaker,
  DefaultAggregateEventsConfig,
} from '../utils/types';
import type { Account } from '../utils/fakes';

describe('create store', () => {
  jest.useFakeTimers({ timerLimit: 100 });

  const profileSchema = z.object({ name: z.string().min(2), accountId: z.string().optional() });
  type Profile = z.infer<typeof profileSchema>;

  const setup = <
    O extends {
      aggregateRepository?: AggregateRepository<Profile & BaseState>;
      authPolicy?: (account: Account | null) => boolean;
      aggregateCommandMaker?: AggregateCommandsMaker<
        Account,
        'PROFILE',
        Profile & BaseState,
        DefaultAggregateEventsConfig<Account, 'PROFILE', Profile & BaseState>
      >;
    }
  >(
    overwrites?: O
  ) => {
    const aggregateRepository =
      overwrites?.aggregateRepository ?? createFakeAggregateRepository<Profile & BaseState>();
    const authAdapter = createFakeAuthAdapter();
    const context = {
      createId,
      authAdapter,
      eventBus: createEventBus(),
      eventsRepository: createFakeEventsRepository(),
    };
    const store = createStore(
      {
        aggregateType: 'PROFILE',
        aggregateSchema: profileSchema,
        aggregateEvents: {
          create: {
            aggregateType: 'PROFILE',
            eventType: 'PROFILE_CREATED',
            operation: 'create' as const,
            payloadSchema: profileSchema,
            authPolicy:
              overwrites?.authPolicy ??
              ((account: Account | null) => account?.roles.includes('creator') ?? false),
            construct: (payload: Profile) => payload,
          },
          update: {
            aggregateType: 'PROFILE',
            eventType: 'PROFILE_UPDATED',
            operation: 'update' as const,
            payloadSchema: profileSchema.partial(),
            authPolicy:
              overwrites?.authPolicy ??
              ((account: Account | null) => account?.roles.includes('updater') ?? false),
            reduce: (state: Profile, payload: Partial<Profile>) => ({ ...state, ...payload }),
          },
          delete: {
            aggregateType: 'PROFILE',
            eventType: 'PROFILE_DELETED',
            operation: 'delete' as const,
            payloadSchema: z.undefined(),
            authPolicy:
              overwrites?.authPolicy ??
              ((account: Account | null) => account?.roles.includes('updater') ?? false),
            destruct: () => {},
          },
        },
        aggregateCommandMaker: overwrites?.aggregateCommandMaker,
        aggregateRepository,
      },
      context
    ) as AggregateStore<
      Account,
      'PROFILE',
      Profile & BaseState,
      DefaultAggregateEventsConfig<Account, 'PROFILE', Profile & BaseState>,
      O['aggregateCommandMaker'] extends AggregateCommandsMaker<
        Account,
        'PROFILE',
        Profile & BaseState,
        DefaultAggregateEventsConfig<Account, 'PROFILE', Profile & BaseState>
      >
        ? O['aggregateCommandMaker']
        : () => {}
    >;
    return { context, store, aggregateRepository };
  };

  it('event updates store state', async () => {
    // Given a store
    const { store } = setup();
    // When a event is called
    const id = await store.create({ name: 'test' });
    // Then the state is updated
    expect(store.state[id]).toMatchObject({ id, name: 'test' });
  });

  it('allows subscribing to store state', async () => {
    // Given a store
    const { store } = setup();
    // And a subscriber to the store
    const subscriber = jest.fn();
    store.subscribe(subscriber);
    subscriber.mockClear();
    // When a event is called
    const id = await store.create({ name: 'test' });
    // Then the subscriber is called
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({ [id]: expect.objectContaining({ name: 'test' }) })
    );
  });

  it('event dispatches event to event bus', async () => {
    // Given a store
    const { store, context } = setup();
    // And a subscriber to the event bus
    const subscriber = jest.fn();
    context.eventBus.subscribe(subscriber);
    // When a event is called
    const id = await store.create({ name: 'test' });
    await jest.advanceTimersByTimeAsync(0);
    // Then an event is dispatched to the given aggregate
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PROFILE_CREATED',
        aggregateId: id,
        payload: { name: 'test' },
      })
    );
  });

  it('event adds metadata to event and state', async () => {
    // Given a store
    const { store, context } = setup();
    // And an auth adapter
    const account = await context.authAdapter.getAccount();
    const deviceId = await context.authAdapter.getDeviceId();
    // And a subscriber to the event bus
    const events = [] as AnyAggregateEvent[];
    const subscriber = jest.fn((e) => events.push(e));
    context.eventBus.subscribe(subscriber);
    // When a event is called
    const id = await store.create({ name: 'test' });
    await jest.advanceTimersByTimeAsync(0);
    // Then an event is dispatched which has appropriate metadata
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'create',
        id: expect.any(String),
        aggregateType: 'PROFILE',
        createdBy: account?.id,
        createdOn: deviceId,
        dispatchedAt: expect.any(Date),
        prevId: undefined,
      })
    );
    // And the state has appropriate metadata
    expect(store.state[id]).toMatchObject({
      createdBy: account?.id,
      createdOn: deviceId,
      lastEventId: events[0].id,
      createdAt: events[0].dispatchedAt,
      updatedAt: events[0].dispatchedAt,
      version: 1,
    });
  });

  it('event validates payload', async () => {
    // Given a store
    const { store, context } = setup();
    // And a subscriber to the event bus
    const subscriber = jest.fn();
    context.eventBus.subscribe(subscriber);
    try {
      // When an invalid payload is passed to a event
      await store.create({ name: '' });
    } catch (e) {
      // Then an InvalidInputError is thrown
      expect(e).toBeInstanceOf(InvalidInputError);
      expect((e as InvalidInputError<ZodError>).cause?.issues[0]).toMatchObject({
        code: 'too_small',
        path: ['name'],
      });
    } finally {
      // And no event is dispatched
      expect(subscriber).not.toHaveBeenCalled();
      // And no state is updated
      expect(store.state).toEqual({});
    }
  });

  it('event validates authorization', async () => {
    // Given a store
    const { store, context } = setup();
    // And a subscriber to the event bus
    const subscriber = jest.fn();
    context.eventBus.subscribe(subscriber);
    // And an account that is unauthorized for the event
    jest
      .spyOn(context.authAdapter, 'getAccount')
      .mockImplementationOnce(async () => ({ id: 'account2', roles: [] }));
    try {
      // When the event is called
      await store.create({ name: 'test' });
    } catch (e) {
      // Then an UnauthorizedError is thrown
      expect(e).toBeInstanceOf(UnauthorizedError);
    } finally {
      // And no event is dispatched
      expect(subscriber).not.toHaveBeenCalled();
      // And no state is updated
      expect(store.state).toEqual({});
    }
  });

  it('update or delete events fail if aggregate does not exist', async () => {
    // Given a store
    const { store, context } = setup();
    // And a subscriber to the event bus
    const subscriber = jest.fn();
    context.eventBus.subscribe(subscriber);
    // When an update event is called on a non-existent aggregate
    expect(() => store.update('p1', { name: 'test' })).rejects.toThrowError(
      // Then an error is thrown
      new NotFoundError('PROFILE aggregate with id p1 not found')
    );
    // When a delete event is called on a non-existent aggregate
    expect(() => store.delete('p1')).rejects.toThrowError(
      // Then an error is thrown as well
      new NotFoundError('PROFILE aggregate with id p1 not found')
    );
    // And no event is dispatched
    expect(subscriber).not.toHaveBeenCalled();
    // And the state is not updated
    expect(store.state).toEqual({});
  });

  it('event persists state in repository', async () => {
    // Given a store with a repository
    const { store, aggregateRepository } = setup();
    // When a event is called
    const id = await store.create({ name: 'test' });
    // Then the state is persisted in the repository
    expect(await aggregateRepository.getOne(id)).toMatchObject({ id, name: 'test' });
  });

  it('event persists event in repository', async () => {
    // Given a store
    const { store, context } = setup();
    // When a event is called
    const id = await store.create({ name: 'test' });
    // Then the event is persisted in the repository
    expect(context.eventsRepository.events).toContainEqual(
      expect.objectContaining({
        id: expect.any(String),
        type: 'PROFILE_CREATED',
        aggregateId: id,
        payload: { name: 'test' },
      })
    );
  });

  it('event can update state', async () => {
    // Given a store with an existing profile
    const { store, aggregateRepository } = setup();
    const id = await store.create({ name: 'tester' });
    // When an update event is called
    await store.update(id, { name: 'renamed tester' });
    // Then the state is updated
    expect(store.state[id]).toMatchObject({ id, name: 'renamed tester' });
    // And the state is persisted in the repository
    expect(await aggregateRepository.getOne(id)).toMatchObject({ id, name: 'renamed tester' });
  });

  it('event can delete state', async () => {
    // Given a store with an existing profile
    const { store, aggregateRepository } = setup();
    const id = await store.create({ name: 'tester' });
    expect(store.state[id]).toMatchObject({ id, name: 'tester' });
    await jest.advanceTimersByTimeAsync(0);
    // When a delete event is called
    await store.delete(id);
    // Then the state is deleted
    expect(store.state).toEqual({});
    expect(store.state[id]).toBeUndefined();
    // And the state is deleted in the repository
    expect(await aggregateRepository.getAll()).toEqual({});
  });

  it('starts up with state persisted to repository', async () => {
    // Given a repository with an existing profile
    const aggregateRepository = createFakeAggregateRepository<Profile & BaseState>();
    await aggregateRepository.create(createAggregateObject({ id: 'p1', name: 'tester' }));
    // When a new store is created with the repository and initialized
    const { store } = setup({ aggregateRepository });
    await store.initialize();
    // Then the state is loaded from the repository
    expect(store.state['p1']).toMatchObject({ id: 'p1', name: 'tester' });
  });

  it('commands have proper context', async () => {
    // Given a store with a create command
    const { store, context } = setup({
      aggregateCommandMaker: ({ events, getState, getAccount }) => ({
        create: async (name?: string) => {
          const account = await getAccount();
          if (Object.values(getState()).find((p) => p.accountId === account?.id)) {
            throw new ConflictError(`profile for account ${account?.id} already exists`);
          }
          await events.create({ name: name ?? 'Anonymous', accountId: account?.id });
        },
      }),
    });
    // And a subscriber to the event bus
    const subscriber = jest.fn();
    context.eventBus.subscribe(subscriber);
    // And an account
    const account = await context.authAdapter.getAccount();
    // When the create command is called
    await store.create();
    await jest.advanceTimersByTimeAsync(0);
    // Then it can use the context to get information and dispatch an event
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PROFILE_CREATED',
        aggregateId: expect.any(String),
        payload: { name: 'Anonymous', accountId: account?.id },
      })
    );
    // When the create command is called again
    expect(() => store.create()).rejects.toThrowError(
      // Then it can access the current state to run custom logic
      new ConflictError(`profile for account ${account?.id} already exists`)
    );
  });

  it('can check initialization status', async () => {
    // Given a store
    const { store } = setup();
    // When a store is created
    setup();
    // Then the store is not initialized
    expect(store.initialized).toBe(false);
    // When the store is initialized
    await store.initialize();
    // Then the store is initialized
    expect(store.initialized).toBe(true);
  });

  it('can be reset', async () => {
    // Given a store
    const { store, aggregateRepository } = setup();
    // Given a profile was created in the repository
    await store.create({ name: 'tester' });
    // And all events have finished processing
    await jest.advanceTimersByTimeAsync(0);
    // When the store is reset
    await store.reset();
    // Then the state is reset
    expect(store.state).toEqual({});
    // And the repository is reset
    expect(await aggregateRepository.getAll()).toEqual({});
  });

  it('throws if trying to define events that would overwrite default functions', () => {
    // Given an aggregate config with conflicting event names
    expect(() =>
      createStore(
        {
          aggregateType: 'PROFILE',
          aggregateEvents: {
            initialize: {
              aggregateType: 'PROFILE',
              eventType: 'PROFILE_INITIALIZED',
              operation: 'create' as const,
              payloadSchema: profileSchema,
              authPolicy: () => true,
              construct: () => ({}),
            },
          },
        },
        {
          createId,
          authAdapter: createFakeAuthAdapter(),
          eventBus: createEventBus(),
        }
      )
    ).toThrowError('events cannot have the following names');
  });

  it('throws if trying to define commands that would overwrite default functions', () => {
    // Given an aggregate config with conflicting event names
    expect(() =>
      createStore(
        {
          aggregateType: 'PROFILE',
          aggregateEvents: {},
          aggregateCommandMaker: () => ({ initialize: () => {} }),
        },
        {
          createId,
          authAdapter: createFakeAuthAdapter(),
          eventBus: createEventBus(),
        }
      )
    ).toThrowError('commands cannot have the following names');
  });

  it('rolls back state and terminates event bus if event cannot be persisted', async () => {
    // Given a store with an existing profile
    const { store, context, aggregateRepository } = setup();
    const oldProfileId = await store.create({ name: 'tester' });
    // And an event repository throws an error on insert
    jest.spyOn(context.eventsRepository, 'create').mockImplementationOnce(async () => {
      throw new Error('insert failed');
    });
    // And a subscriber to the store
    const subscriber = jest.fn();
    store.subscribe(subscriber);
    await jest.advanceTimersByTimeAsync(0);
    subscriber.mockClear();
    // And a termination handler to the event bus
    const handleError = jest.fn();
    context.eventBus.onTermination(handleError);
    // When a create event is called
    const newProfileId = await store.create({ name: 'test' });
    // Then the event bus is terminated with the error
    expect(handleError).toHaveBeenCalledWith(new Error('insert failed'));
    expect(context.eventBus.terminated).toBe(true);
    // And the state is not persisted
    expect(await aggregateRepository.getOne(newProfileId)).toBeUndefined();
    // And the state is rolled back
    expect(Object.keys(store.state)).toHaveLength(1);
    expect(store.state[newProfileId]).toBeUndefined();
    expect(store.state[oldProfileId]).toMatchObject({ id: oldProfileId, name: 'tester' });
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({ [oldProfileId]: expect.any(Object) })
    );
  });

  it('can mark events as recorded', async () => {
    // Given a store with an event server adapter and no account
    const { store, context, aggregateRepository } = setup({ authPolicy: () => true });
    jest.spyOn(context.authAdapter, 'getAccount').mockImplementationOnce(async () => null);
    // And an existing profile
    const id = await store.create({ name: 'tester' });
    expect(store.state[id].createdBy).toBeUndefined();
    expect(context.eventsRepository.events[0].recordedAt).toBeUndefined();
    expect(context.eventsRepository.events[0].createdBy).toBeUndefined();
    // And a subscriber to the store
    const subscriber = jest.fn();
    store.subscribe(subscriber);
    // When an event is marked as recorded
    const recordedEvent = {
      ...context.eventsRepository.events[0],
      recordedAt: new Date(),
      createdBy: createId(),
    };
    await store.markRecorded(recordedEvent);
    // Then the state is marked as recorded
    expect(store.state[id]).toMatchObject({ lastRecordedAt: expect.any(Date) });
    // And the subscriber is called
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        [id]: expect.objectContaining({
          createdBy: recordedEvent.createdBy,
          lastRecordedAt: expect.any(Date),
        }),
      })
    );
    // And the updated state is persisted to the repository
    expect(await aggregateRepository.getOne(id)).toMatchObject({
      createdBy: recordedEvent.createdBy,
      lastRecordedAt: expect.any(Date),
    });
    // And the event is marked as recorded in the repository
    expect(context.eventsRepository.events[0]).toMatchObject({
      recordedAt: expect.any(Date),
      createdBy: recordedEvent.createdBy,
    });
  });

  it('throws error when trying to record event for other aggregate', async () => {
    // Given a store with an event server adapter
    const { store, context } = setup({ authPolicy: () => true });
    // And an event for a different aggregate
    const event = createEvent('OTHER', 'SOMETHING_HAPPENED', {
      createdBy: createId(),
      recordedAt: new Date(),
    });
    // When the event is recorded
    await expect(() => store.markRecorded(event)).rejects.toThrowError(
      // Then an error is thrown
      new Error('PROFILE store cannot record event for OTHER aggregate')
    );
  });

  it('allows applying events to the store without calling a dispatcher', async () => {
    // Given a store
    const { store, context, aggregateRepository } = setup();
    // And a subscriber to the event bus
    const eventSubscriber = jest.fn();
    context.eventBus.subscribe(eventSubscriber);
    // And a subscriber to the store
    const storeSubscriber = jest.fn();
    store.subscribe(storeSubscriber);
    // And an event
    const accountId = createId();
    const event = createEvent('PROFILE', 'PROFILE_CREATED', {
      payload: { name: 'test' },
      createdBy: accountId,
      recordedAt: new Date(),
    });
    // When the event is applied to the store
    store.applyEvent(event);
    await jest.advanceTimersByTimeAsync(0);
    // Then the state is updated
    expect(store.state[event.aggregateId]).toMatchObject({ id: event.aggregateId, name: 'test' });
    // And the state is persisted in the repository
    expect(await aggregateRepository.getOne(event.aggregateId)).toMatchObject({
      id: event.aggregateId,
      name: 'test',
    });
    // And the event is persisted in the repository
    expect(context.eventsRepository.events).toContainEqual(event);
    // And the event is dispatched to the event bus
    expect(eventSubscriber).toHaveBeenCalledWith(event);
    // And the store subscriber is called
    expect(storeSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        [event.aggregateId]: expect.objectContaining({ name: 'test' }),
      })
    );
  });

  it('throws error when trying to apply event for other aggregate', async () => {
    // Given a store
    const { store } = setup();
    // And an event for a different aggregate
    const event = createEvent('OTHER', 'SOMETHING_HAPPENED', {
      createdBy: createId(),
      recordedAt: new Date(),
    });
    // When the event is applied to the store
    await expect(() => store.applyEvent(event)).rejects.toThrowError(
      // Then an error is thrown
      new Error('PROFILE store cannot apply event for OTHER aggregate')
    );
  });

  it('terminates the event bus when an error is thrown during processing', async () => {
    // Given an event bus with a termination handler
    const eventBus = createEventBus();
    const onTermination = jest.fn();
    eventBus.onTermination(onTermination);
    // And a store with an event processor that throws an error
    const store = createStore(
      {
        aggregateType: 'TEST',
        aggregateEvents: {
          failing: {
            aggregateType: 'TEST',
            eventType: 'WILL_FAIL',
            operation: 'create' as const,
            payloadSchema: z.undefined(),
            authPolicy: () => true,
            construct: () => {
              throw new Error('failed');
            },
          },
        },
      },
      { createId, authAdapter: createFakeAuthAdapter(), eventBus }
    );
    // And a subscriber to the store
    const subscriber = jest.fn();
    store.subscribe(subscriber);
    // When the failing event is called
    await store.failing();
    // Then the event bus is terminated
    expect(eventBus.terminated).toBe(true);
    // And the termination handler is called with the error
    expect(onTermination).toHaveBeenCalledWith(new Error('failed'));
    // And the state is rolled back
    expect(store.state).toEqual({});
    // And the subscriber is called
    expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({}));
  });
});
