import { createEvent } from '../utils/fakes';
import type { AnyAggregateEvent } from '../utils/types';
import { createEventBus } from './event-bus';

describe('event bus', () => {
  it('relays dispatched events to subscriber', () => {
    // Given an event bus with a subscriber
    const eventBus = createEventBus();
    const subscriber = jest.fn();
    eventBus.subscribe(subscriber);
    // When an event is dispatched
    const testEvent = createEvent('TEST', 'TEST');
    eventBus.dispatch(testEvent);
    // Then the subscriber is called with it
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(testEvent);
  });

  it('supports multiple subscribers', () => {
    // Given an event bus with two subscriber
    const eventBus = createEventBus();
    const subscriber1 = jest.fn();
    eventBus.subscribe(subscriber1);
    const subscriber2 = jest.fn();
    eventBus.subscribe(subscriber2);
    // When an event is dispatched
    const testEvent = createEvent('TEST', 'TEST');
    eventBus.dispatch(testEvent);
    // Then both subscribers are called with it
    expect(subscriber1).toHaveBeenCalledTimes(1);
    expect(subscriber1).toHaveBeenCalledWith(testEvent);
    expect(subscriber2).toHaveBeenCalledTimes(1);
    expect(subscriber2).toHaveBeenCalledWith(testEvent);
  });

  it('replays past events to new subscribers', () => {
    // Given an event bus to which a few events have been dispatched already
    const eventBus = createEventBus();
    const testEvents = [createEvent('TEST', 'TEST'), createEvent('TEST', 'TEST')] as const;
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

  it('allows subscribers to unsubscribe', () => {
    // Given an event bus with a subscriber
    const eventBus = createEventBus();
    const subscriber = jest.fn();
    const unsubscribe = eventBus.subscribe(subscriber);
    // When the subscriber unsubscribes
    unsubscribe();
    // Then the subscriber is not called anymore
    const testEvent = createEvent('TEST', 'TEST');
    eventBus.dispatch(testEvent);
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('can reset replay behavior', () => {
    // Given an event bus to which a few events have been dispatched already
    const eventBus = createEventBus();
    eventBus.dispatch(createEvent('TEST', 'TEST'));
    eventBus.dispatch(createEvent('TEST', 'TEST'));
    // And the event bus has been reset
    eventBus.reset();
    // Then past events are not replayed
    const subscriber = jest.fn();
    eventBus.subscribe(subscriber);
    expect(subscriber).not.toHaveBeenCalled();
    // But future events will be pushed to new and old subscribers
    const testEvent = createEvent('TEST', 'TEST');
    eventBus.dispatch(testEvent);
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(testEvent);
  });

  it('can be terminated', async () => {
    // Given an event bus with a subscriber
    const eventBus = createEventBus();
    const subscriber = jest.fn();
    eventBus.subscribe(subscriber);
    // When the event bus is terminated
    eventBus.terminate();
    // Then the subscriber is not called anymore
    const testEvent = createEvent('TEST', 'TEST');
    expect(() => eventBus.dispatch(testEvent)).toThrow();
    expect(subscriber).not.toHaveBeenCalled();
    // And the event bus is marked as terminated
    expect(eventBus.terminated).toBe(true);
  });

  it('calls termination handler with error', () => {
    // Given an event bus with an error handler and a subscriber
    const eventBus = createEventBus();
    const errorHandler = jest.fn();
    eventBus.onTermination(errorHandler);
    const subscriber = jest.fn();
    eventBus.subscribe(subscriber);
    // When the event bus is terminated with an error
    const testError = new Error('test');
    eventBus.terminate(testError);
    // Then the error handler is called
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(testError);
    // And the event bus is terminated
    const testEvent = createEvent('TEST', 'TEST');
    expect(() => eventBus.dispatch(testEvent)).toThrow();
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('can receive new events when reset after termination', () => {
    // Given an event bus with a subscriber that has been terminated
    const eventBus = createEventBus();
    const subscriber = jest.fn();
    eventBus.subscribe(subscriber);
    eventBus.terminate();
    expect(eventBus.terminated).toBe(true);
    // When the event bus is reset
    eventBus.reset();
    // Then the event bus is not terminated anymore
    expect(eventBus.terminated).toBe(false);
    // And the subscriber can receive new events
    const testEvent = createEvent('TEST', 'TEST');
    eventBus.dispatch(testEvent);
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(testEvent);
  });
});
