import { UnauthorizedError } from './errors';
import {
  createId,
  createFakeAuthAdapter,
  createFakeEventsRepository,
  createEvent,
  createAggregateObject,
  createFakeEventServerAdapter,
  createFakeAggregateRepository,
  createFakeConnectionStatusAdapter,
} from './fakes';
import { BaseState } from './types';

jest.useFakeTimers();

describe('createId', () => {
  it('returns a string of length 12', () => {
    // When a new id is created
    const id = createId();
    // Then it is a string of length 12
    expect(typeof id).toBe('string');
    expect(id.length).toBe(12);
  });

  it('returns a decently unique id', () => {
    // When 100 ids are created
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      const id = createId();
      // Then each id is unique
      expect(ids.has(id)).toBe(false);
      expect(id.length).toBe(12);
      ids.add(id);
    }
  });
});

describe('fakeAuthAdapter', () => {
  it('returns static account object', async () => {
    // Given an auth adapter
    const authAdapter = createFakeAuthAdapter();
    // When the account is fetched
    const account = await authAdapter.getAccount();
    // Then it has an id of length 12
    expect(account?.id).toEqual(expect.any(String));
    expect(account?.id.length).toBe(12);
    // And it has roles
    expect(account?.roles).toEqual(['creator', 'updater']);
    // And the account id does not change
    expect(await authAdapter.getAccount()).toEqual(account);
  });

  it('returns static device id', async () => {
    const authAdapter = createFakeAuthAdapter();
    // When the device id is fetched
    const deviceId = await authAdapter.getDeviceId();
    // Then it is an id of length 12
    expect(deviceId).toEqual(expect.any(String));
    expect(deviceId.length).toBe(12);
    // And the device id does not change
    expect(await authAdapter.getDeviceId()).toBe(deviceId);
  });
});

describe('createFakeEventsRepository', () => {
  it('can insert a new event', async () => {
    // Given a repository
    const repository = createFakeEventsRepository();
    // and an event
    const event = createEvent('TEST', 'TEST');
    // When the event is inserted
    await repository.create(event);
    // Then the event is saved to the repository
    expect(repository.events).toContain(event);
  });

  it('throws an error if event already exists when trying to insert', async () => {
    // Given a repository with an event
    const repository = createFakeEventsRepository();
    const event = createEvent('TEST', 'TEST');
    await repository.create(event);
    // When the event is inserted again
    await expect(repository.create(event)).rejects.toThrow(
      // Then an error is thrown
      `Event ${event.id} already exists`
    );
  });

  it('can delete all events', async () => {
    // Given a repository with two events
    const repository = createFakeEventsRepository();
    const event1 = createEvent('TEST', 'TEST');
    const event2 = createEvent('TEST', 'TEST');
    await repository.create(event1);
    await repository.create(event2);
    expect(repository.events).toHaveLength(2);
    // When the events are deleted
    await repository.deleteAll();
    // Then there are no events anymore
    expect(repository.events).toHaveLength(0);
  });

  it('can mark existing event as recorded', async () => {
    // Given a repository with an event
    const repository = createFakeEventsRepository();
    const event = createEvent('TEST', 'TEST');
    await repository.create(event);
    // When the event is marked as recorded
    const recordedAt = new Date();
    const accountId = createId();
    await repository.markRecorded(event.id, recordedAt, accountId);
    // Then the recorded time and account are saved
    expect(repository.events[0].recordedAt).toBe(recordedAt);
    expect(repository.events[0].createdBy).toBe(accountId);
  });

  it('throws an error if event to be marked as recorded is not found', async () => {
    // Given a repository without events
    const repository = createFakeEventsRepository();
    // When trying to mark an event as recorded
    await expect(repository.markRecorded('1', new Date(), createId())).rejects.toThrow(
      // Then an error is thrown
      'Event 1 not found'
    );
  });

  it('can get all unrecorded events', async () => {
    // Given a repository with three events, one of which is recorded
    const repository = createFakeEventsRepository();
    const event1 = createEvent('TEST', 'TEST', { recordedAt: new Date() });
    const event2 = createEvent('TEST', 'TEST');
    const event3 = createEvent('TEST', 'TEST');
    await repository.create(event1);
    await repository.create(event2);
    await repository.create(event3);
    // When getting all unrecorded events
    const unrecordedEvents = await repository.getUnrecorded();
    // Then only the unrecorded events are returned
    expect(unrecordedEvents).toContain(event2);
    expect(unrecordedEvents).toContain(event3);
    expect(unrecordedEvents).not.toContain(event1);
  });

  it('can get the last recorded event', async () => {
    // Given a repository with three events recorded out of order
    const repository = createFakeEventsRepository();
    const event1 = createEvent('TEST', 'TEST', { recordedAt: new Date('2023-08-28') });
    const event2 = createEvent('TEST', 'TEST', { recordedAt: new Date('2023-08-29') });
    const event3 = createEvent('TEST', 'TEST', { recordedAt: new Date('2023-08-30') });
    await Promise.all([event2, event3, event1].map(repository.create));
    // When getting the last recorded event
    const lastRecordedEvent = await repository.getLastRecordedEvent();
    // Then the last recorded event is returned
    expect(lastRecordedEvent).toEqual(event3);
  });

  it('returns null if no events have been recorded yet', async () => {
    // Given a repository with only unrecorded events
    const repository = createFakeEventsRepository();
    const event = createEvent('TEST', 'TEST');
    await repository.create(event);
    // When getting the last recorded event
    const lastRecordedEvent = await repository.getLastRecordedEvent();
    // Then null is returned
    expect(lastRecordedEvent).toBeNull();
  });
});

describe('createFakeEventServerAdapter', () => {
  it('can record an event', async () => {
    // Given an auth adapter
    const authAdapter = createFakeAuthAdapter();
    const account = await authAdapter.getAccount();
    // And an event server adapter
    const eventServerAdapter = createFakeEventServerAdapter(authAdapter);
    // When an event is recorded
    const event = createEvent('TEST', 'TEST', { createdBy: account?.id });
    await eventServerAdapter.record(event);
    // Then the event is saved
    expect(eventServerAdapter.recordedEvents).toContainEqual(
      expect.objectContaining({ id: event.id })
    );
    // And the event has a recorded time
    expect(eventServerAdapter.recordedEvents[0].recordedAt).toEqual(expect.any(Date));
    // And the event has a recorded by
    expect(eventServerAdapter.recordedEvents[0].createdBy).toBe(account?.id);
  });

  it('throws an error if no account is found when trying to record an event', async () => {
    // Given an auth adapter that returns no account
    const authAdapter = createFakeAuthAdapter();
    jest.spyOn(authAdapter, 'getAccount').mockImplementation(async () => null);
    // And an event server adapter
    const eventServerAdapter = createFakeEventServerAdapter(authAdapter);
    // When an event is recorded
    const event = createEvent('TEST', 'TEST');
    // Then an error is thrown
    await expect(eventServerAdapter.record(event)).rejects.toThrow(UnauthorizedError);
    await expect(eventServerAdapter.record(event)).rejects.toThrow('Account not found');
  });

  it('throws an error if the account id on the event does not match the server', async () => {
    // Given an auth adapter
    const authAdapter = createFakeAuthAdapter();
    const account = await authAdapter.getAccount();
    // And an event server adapter
    const eventServerAdapter = createFakeEventServerAdapter(authAdapter);
    // When an event is recorded with a different account id
    const event = createEvent('TEST', 'TEST', { createdBy: createId() });
    expect(event.createdBy).not.toBe(account?.id);
    // Then an error is thrown
    await expect(eventServerAdapter.record(event)).rejects.toThrow(UnauthorizedError);
    await expect(eventServerAdapter.record(event)).rejects.toThrow(
      'Event created by different account'
    );
  });

  it('can fetch events that were recorded after a specified event', async () => {
    // Given an event server adapter with three events
    const eventServerAdapter = createFakeEventServerAdapter();
    const event1 = createEvent('TEST', 'TEST', { recordedAt: new Date('2023-08-28') });
    const event2 = createEvent('TEST', 'TEST', { recordedAt: new Date('2023-08-29') });
    const event3 = createEvent('TEST', 'TEST', { recordedAt: new Date('2023-08-30') });
    eventServerAdapter.recordedEvents = [event2, event3, event1];
    // When fetching events after the first event
    const newEvents = await eventServerAdapter.fetch(event1.id);
    // Then only the last two events are returned
    expect(newEvents).toHaveLength(2);
    expect(newEvents).toContainEqual(expect.objectContaining({ id: event2.id }));
    expect(newEvents).toContainEqual(expect.objectContaining({ id: event3.id }));
  });

  it('can fetch all events', async () => {
    // Given an event server adapter with three events
    const eventServerAdapter = createFakeEventServerAdapter();
    const event1 = createEvent('TEST', 'TEST', { recordedAt: new Date('2023-08-28') });
    const event2 = createEvent('TEST', 'TEST', { recordedAt: new Date('2023-08-29') });
    const event3 = createEvent('TEST', 'TEST', { recordedAt: new Date('2023-08-30') });
    eventServerAdapter.recordedEvents = [event2, event3, event1];
    // When fetching events after the first event
    const newEvents = await eventServerAdapter.fetch(null);
    // Then only the last two events are returned
    expect(newEvents).toHaveLength(3);
    expect(newEvents).toContainEqual(expect.objectContaining({ id: event1.id }));
    expect(newEvents).toContainEqual(expect.objectContaining({ id: event2.id }));
    expect(newEvents).toContainEqual(expect.objectContaining({ id: event3.id }));
  });

  it('can subscribe to events and dispatch them', async () => {
    // Given an event server adapter with two subscribers
    const eventServerAdapter = createFakeEventServerAdapter();
    const subscriber1 = jest.fn();
    eventServerAdapter.subscribe!(subscriber1);
    const subscriber2 = jest.fn();
    eventServerAdapter.subscribe!(subscriber2);
    // When an event is dispatched
    const event = createEvent('TEST', 'TEST', { recordedAt: new Date() });
    eventServerAdapter.dispatch(event);
    // Then both subscribers are called with the event
    expect(subscriber1).toHaveBeenCalledWith(event);
    expect(subscriber2).toHaveBeenCalledWith(event);
  });
});

describe('createFakeAggregateRepository', () => {
  it('can insert and get aggregates', async () => {
    // Given a repository
    const repository = createFakeAggregateRepository<{ name: string } & BaseState>();
    // And two aggregates
    const aggregate1 = createAggregateObject({ id: createId(), name: 'Test Aggregate 1' });
    const aggregate2 = createAggregateObject({ id: createId(), name: 'Test Aggregate 2' });
    await repository.create(aggregate1);
    await repository.create(aggregate2);
    // When the aggregates are inserted
    await repository.create(aggregate1);
    await repository.create(aggregate2);
    // Then the aggregates can be retrieved again from the repository
    expect(await repository.getAll()).toEqual({
      [aggregate1.id]: aggregate1,
      [aggregate2.id]: aggregate2,
    });
    // And the aggregates can be retrieved individually
    expect(await repository.getOne(aggregate1.id)).toEqual(aggregate1);
    expect(await repository.getOne(aggregate2.id)).toEqual(aggregate2);
  });

  it('can update an aggregate', async () => {
    // Given a repository with an aggregate
    const repository = createFakeAggregateRepository<{ name: string } & BaseState>();
    const aggregate = createAggregateObject({ id: createId(), name: 'Test Aggregate' });
    await repository.create(aggregate);
    // When the aggregate is updated
    const updatedAggregate = { ...aggregate, name: 'Updated Aggregate' };
    await repository.update(updatedAggregate.id, updatedAggregate);
    // Then the updated aggregate can be retrieved from the repository
    expect(await repository.getOne(aggregate.id)).toEqual(updatedAggregate);
  });

  it('can delete an aggregate', async () => {
    // Given a repository with two aggregates
    const repository = createFakeAggregateRepository<{ name: string } & BaseState>();
    const aggregate1 = createAggregateObject({ id: createId(), name: 'Test Aggregate 1' });
    const aggregate2 = createAggregateObject({ id: createId(), name: 'Test Aggregate 2' });
    await repository.create(aggregate1);
    await repository.create(aggregate2);
    // When an aggregate is deleted
    await repository.delete(aggregate1.id);
    // Then the deleted aggregate is no longer in the repository
    expect(await repository.getOne(aggregate1.id)).toBeUndefined();
    // And the other aggregate is still in the repository
    expect(await repository.getOne(aggregate2.id)).toEqual(aggregate2);
  });

  it('can delete all aggregates', async () => {
    // Given a repository with two aggregates
    const repository = createFakeAggregateRepository<{ name: string } & BaseState>();
    const aggregate1 = createAggregateObject({ id: createId(), name: 'Test Aggregate 1' });
    const aggregate2 = createAggregateObject({ id: createId(), name: 'Test Aggregate 2' });
    await repository.create(aggregate1);
    await repository.create(aggregate2);
    // When all aggregates are deleted
    await repository.deleteAll();
    // Then the repository is empty
    expect(await repository.getAll()).toEqual({});
  });
});

describe('createAggregateObject', () => {
  it('creates an object with the expected aggregate properties', () => {
    // When the aggregate object is created
    const aggregate = createAggregateObject({ id: 'aggregate1', name: 'Test Aggregate' });
    // Then the aggregate object has the expected properties
    expect(aggregate).toHaveProperty('id', 'aggregate1');
    expect(aggregate).toHaveProperty('name', 'Test Aggregate');
    expect(aggregate).toHaveProperty('createdBy', expect.any(String));
    expect(aggregate).toHaveProperty('createdOn', expect.any(String));
    expect(aggregate).toHaveProperty('lastEventId', expect.any(String));
    expect(aggregate).toHaveProperty('createdAt', expect.any(Date));
    expect(aggregate).toHaveProperty('updatedAt', expect.any(Date));
    expect(aggregate).toHaveProperty('version', 1);
  });
});

describe('createEvent', () => {
  it('creates an event with the expected properties', () => {
    // When an event is created
    const event = createEvent('TEST', 'TEST');
    // Then the event has the expected properties
    expect(event).toHaveProperty('id');
    expect(event).toHaveProperty('operation', 'create');
    expect(event).toHaveProperty('aggregateType', 'TEST');
    expect(event).toHaveProperty('aggregateId', expect.any(String));
    expect(event).toHaveProperty('type', 'TEST');
    expect(event).toHaveProperty('payload', {});
    expect(event).toHaveProperty('createdBy', expect.any(String));
    expect(event).toHaveProperty('createdOn', expect.any(String));
    expect(event).toHaveProperty('dispatchedAt', expect.any(Date));
    // And the event has no previous event id
    expect(event).toHaveProperty('prevId', undefined);
    // And the event has no recorded time
    expect(event).toHaveProperty('recordedAt', undefined);
  });

  it('can create an event with a custom payload', () => {
    // When an event is created with a custom payload
    const event = createEvent('TEST', 'TEST', { payload: { name: 'Test Event' } });
    // Then the event has the custom payload
    expect(event).toHaveProperty('payload', { name: 'Test Event' });
  });

  it('can create an event with a custom operation', () => {
    // When an event is created with a custom operation
    const event = createEvent('TEST', 'TEST', { operation: 'update', prevId: 'event1' });
    // Then the event has the custom operation
    expect(event).toHaveProperty('operation', 'update');
  });

  it('can create an event with a custom aggregate id', () => {
    // When an event is created with a custom aggregate id
    const event = createEvent('TEST', 'TEST', { aggregateId: 'aggregate1' });
    // Then the event has the custom aggregate id
    expect(event).toHaveProperty('aggregateId', 'aggregate1');
  });

  it('can create an event with a previous event id', () => {
    // When an event is created with a custom previous event id
    const event = createEvent('TEST', 'TEST', { operation: 'delete', prevId: 'event1' });
    // Then the event has the custom previous event id
    expect(event).toHaveProperty('prevId', 'event1');
  });

  it('can create an event with a recorded time', () => {
    // When an event is created with a custom recorded time
    const recordedAt = new Date();
    const event = createEvent('TEST', 'TEST', { recordedAt });
    // Then the event has the custom recorded time
    expect(event).toHaveProperty('recordedAt', recordedAt);
  });

  it('can create an event with a custom device id', () => {
    // Given an account id
    const accountId = createId();
    // When an event is created with a custom created by
    const event = createEvent('TEST', 'TEST', { createdBy: accountId });
    // Then the event has the custom created by
    expect(event).toHaveProperty('createdBy', accountId);
  });

  it('can create an event with a custom account id', () => {
    // Given a device id
    const deviceId = createId();
    // When an event is created with a custom created on
    const event = createEvent('TEST', 'TEST', { createdOn: deviceId });
    // Then the event has the custom created on
    expect(event).toHaveProperty('createdOn', deviceId);
  });
});

describe('createFakeConnectionStatusAdapter', () => {
  it('can get, set, and subscribe to connection status', async () => {
    // Given a connection status adapter
    const connectionStatusAdapter = createFakeConnectionStatusAdapter();
    // And two subscriber
    const subscriber1 = jest.fn();
    connectionStatusAdapter.subscribe(subscriber1);
    const subscriber2 = jest.fn();
    connectionStatusAdapter.subscribe(subscriber2);
    // Then the subscribers are called with the initial connection status
    await jest.advanceTimersByTimeAsync(0);
    expect(subscriber1).toHaveBeenCalledWith(true);
    expect(subscriber2).toHaveBeenCalledWith(true);
    // And one can get the current connection status
    expect(await connectionStatusAdapter.get()).toBe(true);
    // When the connection status is set
    connectionStatusAdapter.set(false);
    // Then the subscribers are called with the new connection status
    expect(subscriber1).toHaveBeenCalledWith(false);
    expect(subscriber2).toHaveBeenCalledWith(false);
    // And one can get the new connection status
    expect(await connectionStatusAdapter.get()).toBe(false);
  });
});
