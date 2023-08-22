import { ZodError, z } from 'zod';
import { createStore } from './store';
import { createEventBus } from './event-bus';
import { InvalidInputError, UnauthorizedError } from '../utils/errors';
import {
  fakeAuthAdapter,
  createId,
  createFakeAggregateRepository,
  createFakeEventsRepository,
} from '../utils/fakes';
import type { AnyAggregateEvent, BaseState, AggregateRepository } from '../utils/types';
import type { Account } from '../utils/fakes';

describe('store', () => {
  const profileSchema = z.object({ name: z.string().min(2) });
  type Profile = z.infer<typeof profileSchema>;

  const setup = (repository?: AggregateRepository<Profile & BaseState>) => {
    const aggregateRepository = repository || createFakeAggregateRepository<Profile & BaseState>();
    const context = {
      authAdapter: fakeAuthAdapter,
      createId,
      eventsRepository: createFakeEventsRepository(),
      eventBus: createEventBus(),
    };
    const store = createStore(
      {
        aggregateType: 'PROFILE',
        aggregateSchema: profileSchema,
        commands: {
          create: {
            eventType: 'CREATED',
            operation: 'create' as const,
            payloadSchema: profileSchema,
            policy: (account: Account | null) => account?.roles.includes('creator') ?? false,
            construct: ({ name }: Profile) => ({ name }),
          },
          update: {
            eventType: 'UPDATED',
            operation: 'update' as const,
            payloadSchema: profileSchema.partial(),
            policy: (account: Account | null) => account?.roles.includes('updater') ?? false,
            reduce: (state: Profile, payload: Partial<Profile>) => ({ ...state, ...payload }),
          },
          delete: {
            eventType: 'DELETED',
            operation: 'delete' as const,
            payloadSchema: z.undefined(),
            policy: (account: Account | null) => account?.roles.includes('updater') ?? false,
            destruct: () => {},
          },
        },
        repository: aggregateRepository,
      },
      context
    );
    return { context, store, aggregateRepository };
  };

  it('command updates store state', async () => {
    // Given a store
    const { store } = setup();
    // When a command is called
    const id = await store.create({ name: 'test' });
    // Then the state is updated
    expect(store.state[id]).toEqual(expect.objectContaining({ id, name: 'test' }));
  });

  it('allows subscribing to store state', async () => {
    // Given a store
    const { store } = setup();
    // And a subscriber to the store
    const subscriber = jest.fn();
    store.subscribe(subscriber);
    subscriber.mockClear();
    // When a command is called
    const id = await store.create({ name: 'test' });
    // Then the subscriber is called
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({ [id]: expect.objectContaining({ name: 'test' }) })
    );
  });

  it('command dispatches event to event bus', async () => {
    // Given a store
    const { store, context } = setup();
    // And a subscriber to the event bus
    const subscriber = jest.fn();
    context.eventBus.subscribe(subscriber);
    // When a command is called
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

  it('command adds metadata to event and state', async () => {
    // Given a store
    const { store, context } = setup();
    // And a subscriber to the event bus
    const events = [] as AnyAggregateEvent[];
    const subscriber = jest.fn((e) => events.push(e));
    context.eventBus.subscribe(subscriber);
    // When a command is called
    const id = await store.create({ name: 'test' });
    // Then an event is dispatched which has appropriate metadata
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'create',
        id: expect.any(String),
        aggregateType: 'PROFILE',
        createdBy: 'device1',
        createdOn: 'account1',
        dispatchedAt: expect.any(Date),
        prevId: undefined,
      })
    );
    // And the state has appropriate metadata
    expect(store.state[id]).toEqual(
      expect.objectContaining({
        createdBy: 'device1',
        createdOn: 'account1',
        lastEventId: events[0].id,
        createdAt: events[0].dispatchedAt,
        updatedAt: events[0].dispatchedAt,
        version: 1,
      })
    );
  });

  it('command validates payload', async () => {
    // Given a store
    const { store, context } = setup();
    // And a subscriber to the event bus
    const subscriber = jest.fn();
    context.eventBus.subscribe(subscriber);
    try {
      // When an invalid payload is passed to a command
      await store.create({ name: '' });
    } catch (e) {
      // Then an InvalidInputError is thrown
      expect(e).toBeInstanceOf(InvalidInputError);
      expect((e as InvalidInputError<ZodError>).cause?.issues[0]).toEqual(
        expect.objectContaining({ code: 'too_small', path: ['name'] })
      );
    } finally {
      // And no event is dispatched
      expect(subscriber).not.toHaveBeenCalled();
      // And no state is updated
      expect(store.state).toEqual({});
    }
  });

  it('command validates authorization', async () => {
    // Given a store
    const { store, context } = setup();
    // And a subscriber to the event bus
    const subscriber = jest.fn();
    context.eventBus.subscribe(subscriber);
    // And an account that is unauthorized for the command
    jest
      .spyOn(context.authAdapter, 'getAccount')
      .mockImplementationOnce(async () => ({ id: 'account2', roles: [] }));
    try {
      // When the command is called
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

  it('command persists state in repository', async () => {
    // Given a store with a repository
    const { store, aggregateRepository } = setup();
    // When a command is called
    const id = await store.create({ name: 'test' });
    // Then the state is persisted in the repository
    expect(await aggregateRepository.getOne(id)).toEqual(
      expect.objectContaining({ id, name: 'test' })
    );
  });

  it('command persists event in repository', async () => {
    // Given a store
    const { store, context } = setup();
    // When a command is called
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

  it('command can update state', async () => {
    // Given a store with an existing profile
    const { store, aggregateRepository } = setup();
    const id = await store.create({ name: 'tester' });
    // When an update command is called
    await store.update(id, { name: 'renamed tester' });
    // Then the state is updated
    expect(store.state[id]).toEqual(expect.objectContaining({ id, name: 'renamed tester' }));
    // And the state is persisted in the repository
    expect(await aggregateRepository.getOne(id)).toEqual(
      expect.objectContaining({ id, name: 'renamed tester' })
    );
  });

  it('command can delete state', async () => {
    // Given a store with an existing profile
    const { store, aggregateRepository } = setup();
    const id = await store.create({ name: 'tester' });
    // When a delete command is called
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
    await aggregateRepository.insert('profile1', {
      id: 'profile1',
      name: 'tester',
      createdBy: 'device1',
      createdOn: 'account1',
      lastEventId: 'event1',
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    });
    // When a new store is created with the repository and initialized
    const { store } = setup(aggregateRepository);
    await store.initialize();
    // Then the state is loaded from the repository
    expect(store.state['profile1']).toEqual(
      expect.objectContaining({ id: 'profile1', name: 'tester' })
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

  it('rolls back state and terminates event bus if event cannot be persisted', async () => {
    // Given a store with an existing profile
    const { store, context, aggregateRepository } = setup();
    const oldProfileId = await store.create({ name: 'tester' });
    // Given the event repository throws an error on insert
    jest.spyOn(context.eventsRepository, 'insert').mockImplementationOnce(async () => {
      throw new Error('insert failed');
    });
    // And a subscriber to the store
    const subscriber = jest.fn();
    store.subscribe(subscriber);
    subscriber.mockClear();
    // And a termination handler to the event bus
    const handleError = jest.fn();
    context.eventBus.onTermination(handleError);
    // When a create command is called
    const newProfileId = await store.create({ name: 'test' });
    // Then the event bus is terminated with the error
    expect(handleError).toHaveBeenCalledWith(new Error('insert failed'));
    expect(context.eventBus.terminated).toBe(true);
    // And the state is not persisted
    expect(await aggregateRepository.getOne(newProfileId)).toBeUndefined();
    // And the state is rolled back
    expect(Object.keys(store.state)).toHaveLength(1);
    expect(store.state[newProfileId]).toBeUndefined();
    expect(store.state[oldProfileId]).toEqual(
      expect.objectContaining({ id: oldProfileId, name: 'tester' })
    );
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({ [oldProfileId]: expect.any(Object) })
    );
  });
});
