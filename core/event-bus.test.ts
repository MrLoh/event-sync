import { createEventBus } from './event-bus';
import type { AnyAggregateEvent } from '../utils/types';
import type { EventBus } from './event-bus';

describe('event bus', () => {
  let eventSequence = 0;
  const createEvent = (): AnyAggregateEvent => ({
    id: 'event' + eventSequence++,
    operation: 'create',
    aggregateType: 'test',
    aggregateId: 'aggregate1',
    type: 'TESTED',
    payload: { value: 1 },
    dispatchedAt: new Date(),
  });

  let eventBus: EventBus;
  beforeEach(() => {
    eventBus = createEventBus();
  });
  afterEach(() => {
    eventBus.reset();
  });

  it('relays dispatched events to subscriber', () => {
    // Given a subscriber to the event bus
    const subscriber = jest.fn();
    eventBus.subscribe(subscriber);
    // When an event is dispatched
    const testEvent = createEvent();
    eventBus.dispatch(testEvent);
    // Then the subscriber is called with it
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(testEvent);
  });

  it('supports multiple subscribers', () => {
    // Given two subscribers to the event bus
    const subscriber1 = jest.fn();
    eventBus.subscribe(subscriber1);
    const subscriber2 = jest.fn();
    eventBus.subscribe(subscriber2);
    // When an event is dispatched
    const testEvent = createEvent();
    eventBus.dispatch(testEvent);
    // Then both subscribers are called with it
    expect(subscriber1).toHaveBeenCalledTimes(1);
    expect(subscriber1).toHaveBeenCalledWith(testEvent);
    expect(subscriber2).toHaveBeenCalledTimes(1);
    expect(subscriber2).toHaveBeenCalledWith(testEvent);
  });

  it('replays past events to new subscribers', () => {
    // Given a few events have been dispatched already
    const testEvents = [createEvent(), createEvent()];
    eventBus.dispatch(testEvents[0]);
    eventBus.dispatch(testEvents[1]);
    // When a subscriber is added
    const subscriber = jest.fn();
    eventBus.subscribe(subscriber);
    // Then the subscriber is called with all past events
    expect(subscriber).toHaveBeenCalledTimes(2);
    expect(subscriber).toHaveBeenCalledWith(testEvents[0]);
    expect(subscriber).toHaveBeenCalledWith(testEvents[1]);
  });

  it('can reset replay behavior', () => {
    // Given a few events where dispatched
    eventBus.dispatch(createEvent());
    eventBus.dispatch(createEvent());
    // And the event bus has been reset
    eventBus.reset();
    // Then past events are not replayed
    const subscriber = jest.fn();
    eventBus.subscribe(subscriber);
    expect(subscriber).not.toHaveBeenCalled();
    // But future events will be pushed to new and old subscribers
    const testEvent = createEvent();
    eventBus.dispatch(testEvent);
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(testEvent);
  });
});
