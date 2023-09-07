import { z } from 'zod';
import { createBroker } from './broker';
import {
  createId,
  createEvent,
  createFakeAggregateRepository,
  createFakeConnectionStatusAdapter,
  createFakeEventServerAdapter,
  createFakeEventsRepository,
  createFakeAuthAdapter,
} from '../utils/fakes';
import { BaseState } from '../utils/types';

describe('create broker', () => {
  jest.useFakeTimers({ timerLimit: 100 });

  const setup = (overwrites?: {
    eventServerAdapter?: ReturnType<typeof createFakeEventServerAdapter>;
    onTermination?: (error?: Error) => void;
  }) => {
    const retrySyncInterval = 30;
    const eventsRepository = createFakeEventsRepository();
    const aggregateRepository = createFakeAggregateRepository<{ name: string } & BaseState>();
    const authAdapter = createFakeAuthAdapter();
    const eventServerAdapter =
      overwrites?.eventServerAdapter ?? createFakeEventServerAdapter(authAdapter);
    const connectionStatusAdapter = createFakeConnectionStatusAdapter();
    const broker = createBroker({
      createId,
      defaultPolicy: () => true,
      authAdapter,
      eventsRepository,
      eventServerAdapter,
      connectionStatusAdapter,
      retrySyncInterval,
      onTermination: overwrites?.onTermination,
    });
    const store = broker
      .aggregate('profile')
      .schema(z.object({ name: z.string().min(2) }), { createDefaultEvents: true })
      .repository(aggregateRepository)
      .register();
    return {
      eventsRepository,
      eventServerAdapter,
      connectionStatusAdapter,
      broker,
      store,
      aggregateRepository,
      retrySyncInterval,
    };
  };

  it('can act as context for aggregate builder', () => {
    // Given a broker with a create id and a default policy function
    const createId = jest.fn(() => 'test');
    const defaultPolicy = jest.fn(() => true);
    const broker = createBroker({ authAdapter: createFakeAuthAdapter(), createId, defaultPolicy });
    // When an aggregate config is defined
    const { config } = broker
      .aggregate('profile')
      .schema(z.object({ name: z.string() }), { createDefaultEvents: true });
    // Then is has the correct create id function
    expect(config.createId).toBe(createId);
    // And it has the correct default policy
    expect(config.aggregateEvents.create.authPolicy).toBe(defaultPolicy);
  });

  it('can act as context to create aggregate store', async () => {
    // Given a broker with an auth adapter and an event repository
    const authAdapter = createFakeAuthAdapter();
    jest.spyOn(authAdapter, 'getAccount');
    jest.spyOn(authAdapter, 'getDeviceId');
    const eventsRepository = createFakeEventsRepository();
    jest.spyOn(eventsRepository, 'create');
    const broker = createBroker({
      createId,
      defaultPolicy: () => true,
      authAdapter,
      eventsRepository,
    });
    // When an aggregate store is created
    const { config } = broker
      .aggregate('profile')
      .schema(z.object({ name: z.string().min(2) }), { createDefaultEvents: true });
    const store = broker.register(config);
    // Then it uses the correct auth adapter
    const id = await store.create({ name: 'test' });
    expect(authAdapter.getAccount).toHaveBeenCalled();
    expect(authAdapter.getDeviceId).toHaveBeenCalled();
    // And it uses the correct event repository
    expect(eventsRepository.create).toHaveBeenCalled();
    expect(eventsRepository.events).toHaveLength(1);
    expect(eventsRepository.events[0]).toMatchObject({
      aggregateType: 'profile',
      aggregateId: id,
      type: 'profile.create',
      payload: { name: 'test' },
    });
  });

  it('syncs events to server', async () => {
    // Given a broker with a server adapter
    const { store, eventServerAdapter, eventsRepository } = setup();
    jest.spyOn(eventServerAdapter, 'record');
    // When an event is dispatched
    const id = await store.create({ name: 'test' });
    // Then it is recorded with the event server adapter
    expect(eventServerAdapter.record).toHaveBeenCalled();
    expect(eventServerAdapter.recordedEvents).toHaveLength(1);
    expect(eventServerAdapter.recordedEvents[0]).toMatchObject({
      aggregateType: 'profile',
      aggregateId: id,
      type: 'profile.create',
      payload: { name: 'test' },
    });
    // And the recorded time is stored in the persisted event
    await jest.advanceTimersByTimeAsync(0);
    expect(eventsRepository.events).toHaveLength(1);
    expect(eventsRepository.events[0]).toMatchObject({
      aggregateType: 'profile',
      aggregateId: id,
      type: 'profile.create',
      payload: { name: 'test' },
      recordedAt: expect.any(Date),
    });
    // And the store state is updated
    expect(store.state[id]).toMatchObject({ lastRecordedAt: expect.any(Date) });
  });

  it('only syncs events to the server if there is an account', async () => {
    // Given a broker with a server and auth adapter
    const { broker, store, eventServerAdapter, eventsRepository } = setup();
    jest.spyOn(eventServerAdapter, 'record');
    // And there is no account setup on the device
    jest.spyOn(broker.authAdapter, 'getAccount').mockImplementation(async () => null);
    // When an event is dispatched
    const id = await store.create({ name: 'test' });
    // Then the store state is updated
    expect(store.state[id]).toMatchObject({ id, name: 'test', createdBy: undefined });
    // And the event is persisted to the events repository
    expect(eventsRepository.events).toHaveLength(1);
    expect(eventsRepository.events[0]).toMatchObject({
      aggregateId: id,
      type: 'profile.create',
      payload: { name: 'test' },
      createdBy: undefined,
    });
    // But it is not recorded with the event server adapter
    await jest.advanceTimersByTimeAsync(0);
    expect(eventServerAdapter.record).not.toHaveBeenCalled();
    // When an account becomes available
    const accountId = createId();
    jest
      .spyOn(broker.authAdapter, 'getAccount')
      .mockImplementation(async () => ({ id: accountId, roles: [] }));
    // And a sync is triggered
    await broker.sync();
    // Then the events are synced to the backend
    await jest.advanceTimersByTimeAsync(0);
    expect(eventServerAdapter.record).toHaveBeenCalledTimes(1);
    expect(eventServerAdapter.record).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: id,
        type: 'profile.create',
        payload: { name: 'test' },
        createdBy: accountId,
      })
    );
    // And the events are marked as recorded and created by the account
    expect(eventsRepository.events.filter((e) => e.recordedAt)).toHaveLength(1);
    expect(eventsRepository.events).toContainEqual(
      expect.objectContaining({
        aggregateId: id,
        type: 'profile.create',
        payload: { name: 'test' },
        createdBy: accountId,
        recordedAt: expect.any(Date),
      })
    );
    // And the store state is updated
    expect(store.state[id]).toMatchObject({
      createdBy: accountId,
      lastRecordedAt: expect.any(Date),
    });
  });

  it('if device comes back online previously dispatched events are synced', async () => {
    // Given a broker with a server adapter and a connection status adapter
    const {
      store,
      eventServerAdapter,
      eventsRepository,
      connectionStatusAdapter,
      retrySyncInterval,
    } = setup();
    // And events were dispatched while the device was offline
    connectionStatusAdapter.set(false);
    jest.spyOn(eventServerAdapter, 'record').mockImplementation(async () => {
      throw new Error('network not available');
    });
    const id = await store.create({ name: 'test' });
    await store.update(id, { name: 'test2' });
    expect(eventsRepository.events).toHaveLength(2);
    expect(eventsRepository.events.filter((e) => !e.recordedAt)).toHaveLength(2);
    // When the device comes back online
    jest.spyOn(eventServerAdapter, 'record').mockRestore();
    jest.spyOn(eventServerAdapter, 'record');
    connectionStatusAdapter.set(true);
    await jest.advanceTimersByTimeAsync(retrySyncInterval);
    // Then the events are sent to the server
    expect(eventServerAdapter.record).toHaveBeenCalledTimes(2);
    // And the events are marked as recorded
    expect(eventsRepository.events).toHaveLength(2);
    expect(eventsRepository.events.filter((e) => !e.recordedAt)).toHaveLength(0);
  });

  it('periodically retries syncing failed events', async () => {
    // Given a broker with a server adapter and a connection status adapter
    const {
      store,
      eventServerAdapter,
      eventsRepository,
      connectionStatusAdapter,
      retrySyncInterval,
    } = setup();
    // And events were dispatched while the device was offline
    connectionStatusAdapter.set(false);
    jest.spyOn(eventServerAdapter, 'record').mockImplementation(async () => {
      throw new Error('network not available');
    });
    const id = await store.create({ name: 'test' });
    await store.update(id, { name: 'test2' });
    expect(eventsRepository.events).toHaveLength(2);
    expect(eventsRepository.events.filter((e) => !e.recordedAt)).toHaveLength(2);
    expect(eventServerAdapter.record).toHaveBeenCalledTimes(2);
    // When the device comes back online but the sync still fails
    connectionStatusAdapter.set(true);
    await jest.advanceTimersByTimeAsync(retrySyncInterval);
    expect(eventServerAdapter.record).toHaveBeenCalledTimes(4);
    // Then it retries after a while
    jest.spyOn(eventServerAdapter, 'record').mockRestore();
    jest.spyOn(eventServerAdapter, 'record');
    await jest.advanceTimersByTimeAsync(retrySyncInterval);
    // And the events are sent to the server
    expect(eventServerAdapter.record).toHaveBeenCalledTimes(2);
    // And the events are marked as recorded
    expect(eventsRepository.events).toHaveLength(2);
    expect(eventsRepository.events.filter((e) => !e.recordedAt)).toHaveLength(0);
  });

  it('syncs available events at startup', async () => {
    // Given there are new events available from the backend
    const eventServerAdapter = createFakeEventServerAdapter();
    jest.spyOn(eventServerAdapter, 'fetch');
    const serverEvent1 = createEvent('profile', 'profile.create', {
      payload: { name: 'server' },
      recordedAt: new Date(),
    });
    const serverEvent2 = createEvent('profile', 'profile.update', {
      operation: 'update',
      payload: { name: 'server2' },
      aggregateId: serverEvent1.aggregateId,
      prevId: serverEvent1.id,
      recordedAt: new Date(),
    });
    eventServerAdapter.dispatch(serverEvent1);
    eventServerAdapter.dispatch(serverEvent2);
    // When the broker is initialized
    const { store } = setup({ eventServerAdapter });
    const subscription = jest.fn();
    store.subscribe(subscription);
    await jest.advanceTimersByTimeAsync(0);
    // Then all events after the latest event not recorded are fetched from the backend
    expect(eventServerAdapter.fetch).toHaveBeenCalledWith(null);
    // And the store state is updated
    expect(Object.values(store.state)).toContainEqual(expect.objectContaining({ name: 'server2' }));
    // And the subscribers are notified
    expect(subscription).toHaveBeenCalledWith({
      [serverEvent1.aggregateId]: expect.objectContaining({ name: 'server2' }),
    });
  });

  it('can trigger a sync manually', async () => {
    // Given an broker with an event server adapter without subscriptions
    const { subscribe, ...eventServerAdapter } = createFakeEventServerAdapter();
    const { broker, store, eventsRepository, retrySyncInterval } = setup({ eventServerAdapter });
    await jest.advanceTimersByTimeAsync(retrySyncInterval / 4);
    // When there are new events dispatched on the server
    const serverEvent = createEvent('profile', 'profile.create', {
      payload: { name: 'server' },
      recordedAt: new Date(),
    });
    eventServerAdapter.dispatch(serverEvent);
    await jest.advanceTimersByTimeAsync(retrySyncInterval / 4);
    expect(store.state).toEqual({});
    // And a sync is triggered manually
    await broker.sync();
    await jest.advanceTimersByTimeAsync(0);
    // Then the store state is updated
    expect(Object.values(store.state)).toContainEqual(
      expect.objectContaining({ id: serverEvent.aggregateId, name: 'server' })
    );
    // And the event is persisted
    expect(eventsRepository.events).toHaveLength(1);
    expect(eventsRepository.events[0]).toMatchObject({
      aggregateType: 'profile',
      aggregateId: serverEvent.aggregateId,
      type: 'profile.create',
      payload: { name: 'server' },
    });
  });

  it('subscribes to new events dispatched to the server from other devices', async () => {
    // Given a broker with a server adapter that supports subscriptions
    const { store, eventServerAdapter, eventsRepository } = setup();
    await jest.advanceTimersByTimeAsync(0);
    // When there are new events dispatched on the server
    const event = createEvent('profile', 'profile.create', {
      payload: { name: 'other client' },
      recordedAt: new Date(),
    });
    eventServerAdapter.dispatch(event);
    await jest.advanceTimersByTimeAsync(0);
    // Then the state is updated in the store
    expect(store.state).toEqual(
      expect.objectContaining({
        [event.aggregateId]: expect.objectContaining({
          id: event.aggregateId,
          name: 'other client',
        }),
      })
    );
    // And the event is persisted
    expect(eventsRepository.events).toHaveLength(1);
    expect(eventsRepository.events[0]).toMatchObject({
      aggregateType: 'profile',
      aggregateId: event.aggregateId,
      type: 'profile.create',
      payload: { name: 'other client' },
    });
  });

  it('can clean up server adapter subscriptions', async () => {
    // Given a broker with a server adapter that supports subscriptions
    const { broker, eventServerAdapter, eventsRepository, retrySyncInterval } = setup();
    await jest.advanceTimersByTimeAsync(0);
    // When the broker clean up function is called
    broker.cleanup();
    // Then no more events are dispatched to the broker
    const event = createEvent('profile', 'profile.create', {
      payload: { name: 'other client' },
      recordedAt: new Date(),
    });
    eventServerAdapter.dispatch(event);
    await jest.advanceTimersByTimeAsync(retrySyncInterval);
    expect(eventsRepository.events).toHaveLength(0);
  });

  it('can reset broker to initial state', async () => {
    // Given a broker with an events repository
    const { broker, store, eventsRepository, aggregateRepository } = setup();
    // And a few aggregates were created
    await store.create({ name: 'test' });
    await store.create({ name: 'test2' });
    // And the events were recorded
    expect(eventsRepository.events).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(0);
    // And a subscriber to the store
    const subscriber = jest.fn();
    store.subscribe(subscriber);
    // When the broker is reset
    await broker.reset();
    // Then the events are deleted from the repository
    expect(eventsRepository.events).toHaveLength(0);
    // And the store state is reset
    expect(store.state).toEqual({});
    // And all subscribers are notified
    expect(subscriber).toHaveBeenCalledWith({});
    // And the events are deleted from the repository
    expect(await aggregateRepository.getAll()).toEqual({});
  });

  it('can set a termination handler', async () => {
    // Given a broker with a termination handler
    const terminationHandler = jest.fn();
    const { broker, eventServerAdapter, eventsRepository } = setup({
      onTermination: terminationHandler,
    });
    // When event bus terminates with an error
    broker.eventBus.terminate(new Error('test'));
    // Then the termination handler is called
    expect(terminationHandler).toHaveBeenCalled();
    expect(terminationHandler).toHaveBeenCalledWith(new Error('test'));
    expect(broker.eventBus.terminated).toBe(true);
    await jest.advanceTimersByTimeAsync(0);
    // And new events are not dispatched to the broker
    const event = createEvent('profile', 'profile.create', {
      payload: { name: 'other client' },
      recordedAt: new Date(),
    });
    eventServerAdapter.dispatch(event);
    await jest.advanceTimersByTimeAsync(0);
    expect(eventsRepository.events).toHaveLength(0);
    // And even manual syncs cannot dispatch events to the broker
    await broker.sync();
    await jest.advanceTimersByTimeAsync(0);
    expect(eventsRepository.events).toHaveLength(0);
  });
});
