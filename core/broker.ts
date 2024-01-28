import { BehaviorSubject, filter, interval, throttleTime, merge } from 'rxjs';
import { tryCatch } from '../utils/result';
import { type EventBus, createEventBus } from './event-bus';
import { type AggregateStore, createStore, AnyAggregateStore } from './store';
import { createContext, type AggregateConfigBuilder } from './aggregate';

import type {
  AccountInterface,
  AggregateEventConfig,
  AggregateConfig,
  AnyAggregateEvent,
  AuthAdapter,
  BaseState,
  ConnectionStatusAdapter,
  EventServerAdapter,
  EventsRepository,
  Operation,
  EventDispatchPolicy,
  AggregateCommandsMaker,
} from '../utils/types';

export type Broker<U extends AccountInterface> = {
  /** The auth adapter to get device ids and accounts */
  authAdapter: AuthAdapter<U>;
  /** The id generator */
  createEventId: () => string;
  /** The repository for persisting events */
  eventsRepository?: EventsRepository;
  /** The main event bus */
  eventBus: EventBus;
  /**
   * Register an aggregate config with the broker
   *
   * @param agg the aggregate config to register
   * @returns an aggregate store object
   */
  register: <
    A extends string,
    S extends BaseState,
    E extends { [fn: string]: AggregateEventConfig<U, A, any, any, S, any> },
    C extends AggregateCommandsMaker<U, A, S, E>
  >(
    agg: AggregateConfig<U, A, S, E, C> | { config: AggregateConfig<U, A, S, E, C> }
  ) => AggregateStore<U, A, S, E, C>;
  /**
   * Create an aggregate with the broker as a context
   *
   * @param aggregateType the name of the aggregate
   * @param options optional options for the aggregate
   * @returns an aggregate config builder with a register function
   */
  aggregate: <A extends string>(
    aggregateType: A,
    options?: {
      createAggregateId?: () => string;
      defaultEventDispatchPolicy?: EventDispatchPolicy<U, BaseState, unknown>;
    }
  ) => AggregateConfigBuilder<U, A, BaseState, {}, () => {}, true>;
  /**
   * Syncs events that failed to record. This should be called after login since events are only
   * synced if the account adapter returns an account.
   *
   * @returns a promise that resolves when the sync is complete
   * @throws {StorageError} if the sync fails to persist event recording
   * @throws {UnauthorizedError} if the sync fails due to an authorization error
   */
  sync: () => Promise<void>;
  /**
   * Reset the event bus, delete all events from the repository, and reset the state of all stores
   * including deleting all aggregates from the corresponding repositories. This should be called on
   * logout.
   */
  reset: () => Promise<void>;
  /**
   * Cleanup the broker by unsubscribing from all subscriptions. This should be called on the server
   * after a request has been resolved.
   */
  cleanup: () => void;
  /**
   * Subscribe to events dispatched on the event bus
   *
   * @param subscriber the subscriber function
   * @returns a function to unsubscribe
   */
  subscribeToEvents: (subscriber: (event: AnyAggregateEvent) => void) => () => void;
};

const connectionStatusObservable = (connectionStatusAdapter?: ConnectionStatusAdapter) => {
  const connected$ = new BehaviorSubject(connectionStatusAdapter ? false : true);
  if (connectionStatusAdapter) {
    connectionStatusAdapter.get().then((connected) => {
      if (connected !== null) connected$.next(connected);
    });
    connectionStatusAdapter.subscribe((connected) => {
      if (connected !== null) connected$.next(connected);
    });
  }
  return connected$;
};

export const createBroker = <U extends AccountInterface>({
  authAdapter,
  createEventId,
  defaultEventDispatchPolicy,
  eventsRepository,
  eventServerAdapter,
  connectionStatusAdapter,
  retrySyncInterval = 5 * 60 * 1000,
  onTermination,
}: {
  authAdapter: AuthAdapter<U>;
  createEventId: () => string;
  defaultEventDispatchPolicy?: EventDispatchPolicy<U, BaseState, unknown>;
  eventsRepository?: EventsRepository;
  eventServerAdapter?: EventServerAdapter;
  connectionStatusAdapter?: ConnectionStatusAdapter;
  retrySyncInterval?: number;
  onTermination?: (error?: Error) => void;
}): Broker<U> => {
  // create event bus
  const eventBus = createEventBus();
  if (onTermination) eventBus.onTermination(onTermination);

  const applyEvent = (event: AnyAggregateEvent) => stores[event.aggregateType]!.applyEvent(event);
  const recordEvent = async (event: AnyAggregateEvent) => {
    if (event.recordedAt) return;
    const account = await authAdapter.getAccount();
    if (account && eventServerAdapter) {
      // TODO: explicitly handle things like authorization errors and implement rollbacks
      const { val: recordedEvent } = await tryCatch(() => eventServerAdapter.record(event));
      if (recordedEvent) stores[event.aggregateType]!.markRecorded(recordedEvent);
    }
  };

  if (eventServerAdapter) eventBus.subscribe(recordEvent);

  let activeSync: Promise<void> | null = null;
  const sync = () => {
    if (activeSync) return activeSync;
    activeSync = (async () => {
      if (eventsRepository && eventServerAdapter) {
        // store any unrecorded events
        const events = await eventsRepository.getUnrecorded();
        if (events.length) {
          await Promise.all(events.map(recordEvent));
        }
        // fetch any new events
        const lastReceivedEvent = await eventsRepository.getLastReceivedEvent();
        // TODO: make errors from event server adapter more specific
        const { val: newEvents } = await tryCatch(() =>
          eventServerAdapter.fetch(lastReceivedEvent?.id ?? null)
        );
        if (newEvents && newEvents.length) newEvents.map(applyEvent);
      }
      activeSync = null;
    })();
    return activeSync;
  };

  const initialize = () => {
    // subscribe to server events to dispatch them on client
    let unsubscribeFromServerAdapter: (() => void) | undefined;
    if (eventServerAdapter?.subscribe) {
      unsubscribeFromServerAdapter = eventServerAdapter.subscribe(applyEvent);
    }
    // retry syncing events periodically and when device comes online
    const periodicSyncSubscription = merge(
      connectionStatusObservable(connectionStatusAdapter).pipe(filter((c) => c === true)),
      interval(retrySyncInterval)
    )
      .pipe(throttleTime(retrySyncInterval / 5))
      .subscribe(sync);
    // return unsubscribe function
    return () => {
      if (unsubscribeFromServerAdapter) unsubscribeFromServerAdapter();
      periodicSyncSubscription.unsubscribe();
    };
  };
  let unsubscribe = initialize();

  const stores: { [aggregateType: string]: AnyAggregateStore<U> } = {};
  const register = <
    A extends string,
    S extends BaseState,
    E extends { [fn: string]: AggregateEventConfig<U, A, Operation, string, S, any> },
    C extends AggregateCommandsMaker<U, A, S, E>
  >(
    agg: AggregateConfig<U, A, S, E, C> | { config: AggregateConfig<U, A, S, E, C> }
  ) => {
    const store = createStore(agg, {
      createEventId,
      authAdapter,
      eventBus,
      eventsRepository,
    });
    const aggregateType = 'config' in agg ? agg.config.aggregateType : agg.aggregateType;
    stores[aggregateType] = store;
    return store;
  };

  const aggBuilderCtx = createContext<U>({
    createEventId,
    defaultEventDispatchPolicy,
  });
  const aggregate = <A extends string>(
    aggregateType: A,
    options?: {
      createAggregateId?: () => string;
      defaultEventDispatchPolicy?: EventDispatchPolicy<U, BaseState, unknown>;
    }
  ) => aggBuilderCtx.aggregate(aggregateType, { ...options, register });

  const reset = async () => {
    unsubscribe();
    if (eventsRepository) await eventsRepository.deleteAll();
    eventBus.reset();
    await Promise.all(Object.values(stores).map((store) => store.reset()));
    unsubscribe = initialize();
  };

  return {
    createEventId,
    authAdapter,
    eventBus,
    register,
    aggregate,
    sync,
    reset,
    cleanup: () => {
      unsubscribe();
    },
    subscribeToEvents: eventBus.subscribe,
  };
};
