import { BehaviorSubject, filter, interval, throttleTime, merge } from 'rxjs';
import { tryCatch } from '../utils/result';
import { type EventBus, createEventBus } from './event-bus';
import { type AggregateStore, createStore } from './store';
import { createAggregateContext, type AggregateConfigBuilder } from './aggregate';

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
  Policy,
} from '../utils/types';

export type Broker<U extends AccountInterface> = {
  /** The auth adapter to get device ids and accounts */
  authAdapter: AuthAdapter<U>;
  /** The id generator */
  createId: () => string;
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
    C extends {
      [fn: string]: AggregateEventConfig<U, A, any, any, S, any>;
    }
  >(
    agg: AggregateConfig<U, A, S, C>
  ) => AggregateStore<U, A, S, C>;
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
      createId?: () => string;
      defaultPolicy?: Policy<U, unknown>;
    }
  ) => AggregateConfigBuilder<U, A, BaseState, {}, true>;
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
  createId,
  defaultPolicy,
  eventsRepository,
  eventServerAdapter,
  connectionStatusAdapter,
  retrySyncInterval = 5 * 60 * 1000,
  onTermination,
}: {
  authAdapter: AuthAdapter<U>;
  createId: () => string;
  defaultPolicy?: Policy<U, unknown>;
  eventsRepository?: EventsRepository;
  eventServerAdapter?: EventServerAdapter;
  connectionStatusAdapter?: ConnectionStatusAdapter;
  retrySyncInterval?: number;
  onTermination?: (error?: Error) => void;
}): Broker<U> => {
  // create event bus
  const eventBus = createEventBus();
  if (onTermination) eventBus.onTermination(onTermination);

  const recordEvent = async (event: AnyAggregateEvent) => {
    const account = await authAdapter.getAccount();
    if (!eventServerAdapter || !account) return;
    // TODO: make errors from event server adapter more specific
    const { val } = await tryCatch(() => eventServerAdapter.record(event));
    if (val && eventsRepository) {
      await eventsRepository.markRecorded(val.eventId, val.recordedAt, val.recordedBy);
      stores[event.aggregateType]?.markRecorded(event.aggregateId, val.recordedAt, val.recordedBy);
    }
  };

  // TODO: device way to guarantee at least once delivery of events to the store to ensure the state
  // is updated and the event is persisted in the repository
  const dispatchEvent = async (event: AnyAggregateEvent) => {
    if (!eventBus.terminated) eventBus.dispatch(event);
  };

  let activeSync: Promise<void> | null = null;
  const sync = async () => {
    if (activeSync) return activeSync;
    activeSync = (async () => {
      if (eventsRepository && eventServerAdapter) {
        // store any unrecorded events
        const events = await eventsRepository.getUnrecorded();
        if (events.length) await Promise.all(events.map(recordEvent));
        // fetch any new events
        const lastRecordedEvent = await eventsRepository.getLastRecordedEvent();
        // TODO: make errors from event server adapter more specific
        const { val: newEvents } = await tryCatch(() =>
          eventServerAdapter?.fetch(lastRecordedEvent?.id || null)
        );
        if (newEvents?.length) newEvents.map(dispatchEvent);
      }
      activeSync = null;
    })();
  };

  const initialize = () => {
    // subscribe client events to record them to server
    const unsubscribeFromEventBus = eventBus.subscribe((event) => {
      if (!event.recordedAt) recordEvent(event);
    });
    // subscribe to server events to dispatch them on client
    let unsubscribeFromServerAdapter: (() => void) | undefined;
    if (eventServerAdapter?.subscribe) {
      unsubscribeFromServerAdapter = eventServerAdapter.subscribe(dispatchEvent);
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
      unsubscribeFromEventBus();
      unsubscribeFromServerAdapter?.();
      periodicSyncSubscription.unsubscribe();
    };
  };
  let unsubscribe = initialize();

  const stores: { [aggregateType: string]: AggregateStore<U, any, any, any> } = {};
  const register = <
    A extends string,
    S extends BaseState,
    C extends {
      [fn: string]: AggregateEventConfig<U, A, Operation, string, S, any>;
    }
  >(
    agg: AggregateConfig<U, A, S, C>
  ) => {
    const store = createStore(agg, { authAdapter, createId, eventsRepository, eventBus });
    stores[agg.aggregateType] = store;
    return store;
  };

  const aggBuilderCtx = createAggregateContext<U>({ createId, defaultPolicy });
  const aggregate = <A extends string>(
    aggregateType: A,
    options?: {
      createId?: () => string;
      defaultPolicy?: Policy<U, unknown>;
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
    createId,
    authAdapter,
    eventBus,
    register,
    aggregate,
    sync,
    reset,
    cleanup: () => {
      unsubscribe();
    },
  };
};
