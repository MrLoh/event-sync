import { ZodError, z } from 'zod';
import { createStore } from './store';
import { createEventBus } from './event-bus';
import { ConflictError, InvalidInputError, UnauthorizedError } from '../utils/errors';
import {
  createId,
  createFakeAuthAdapter,
  createFakeAggregateRepository,
  createFakeEventsRepository,
  createAggregateObject,
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
  const profileSchema = z.object({ name: z.string().min(2), accountId: z.string().optional() });
  type Profile = z.infer<typeof profileSchema>;

  const setup = <
    C extends AggregateCommandsMaker<
      Account,
      'PROFILE',
      Profile & BaseState,
      DefaultAggregateEventsConfig<Account, 'PROFILE', Profile & BaseState>
    >
  >(overwrites?: {
    aggregateRepository?: AggregateRepository<Profile & BaseState>;
    authPolicy?: (account: Account | null) => boolean;
    aggregateCommandMaker?: C;
  }) => {
    const aggregateRepository =
      overwrites?.aggregateRepository ?? createFakeAggregateRepository<Profile & BaseState>();
    const context = {
      authAdapter: createFakeAuthAdapter(),
      createId,
      eventsRepository: createFakeEventsRepository(),
      eventBus: createEventBus(),
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
    );
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
        { authAdapter: createFakeAuthAdapter(), createId, eventBus: createEventBus() }
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
        { authAdapter: createFakeAuthAdapter(), createId, eventBus: createEventBus() }
      )
    ).toThrowError('commands cannot have the following names');
  });

  it('rolls back state and terminates event bus if event cannot be persisted', async () => {
    // Given a store with an existing profile
    const { store, context, aggregateRepository } = setup();
    const oldProfileId = await store.create({ name: 'tester' });
    // Given the event repository throws an error on insert
    jest.spyOn(context.eventsRepository, 'create').mockImplementationOnce(async () => {
      throw new Error('insert failed');
    });
    // And a subscriber to the store
    const subscriber = jest.fn();
    store.subscribe(subscriber);
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

  it('can mark aggregate as recorded', async () => {
    // Given a store with an existing profile that was created without an account
    const { store, context } = setup({ authPolicy: () => true });
    jest.spyOn(context.authAdapter, 'getAccount').mockImplementation(async () => null);
    const id = await store.create({ name: 'tester' });
    expect(store.state[id]).toMatchObject({ createdBy: undefined });
    // And a subscriber to the store
    const subscriber = jest.fn();
    store.subscribe(subscriber);
    // When the aggregate is marked as recorded
    const accountId = createId();
    await store.markRecorded(id, new Date(), accountId);
    // Then the state is marked as recorded
    expect(store.state[id]).toMatchObject({ lastRecordedAt: expect.any(Date) });
    // And the created by is set to the account id
    expect(store.state[id].createdBy).toBe(accountId);
    // And the subscriber is called
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        [id]: expect.objectContaining({ createdBy: accountId, lastRecordedAt: expect.any(Date) }),
      })
    );
  });
});
