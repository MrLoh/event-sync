import { BehaviorSubject, filter, interval, throttleTime, merge } from 'rxjs';
import { tryCatch } from '../utils/try-catch';
import { type EventBus, createEventBus } from './event-bus';
import { type AggregateStore, createStore } from './store';
import { createAggregateContext, type AggregateConfigBuilder } from './aggregate';

import type {
  AccountInterface,
  AggregateCommandConfig,
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
  /** the main event bus */
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
      [fn: string]: AggregateCommandConfig<U, A, any, any, S, any>;
    }
  >(
    agg: AggregateConfig<U, A, S, C>
  ) => AggregateStore<U, A, S, C>;
  /**
   *
   * @param aggregateType
   * @param options
   * @returns
   */
  aggregate: <A extends string>(
    aggregateType: A,
    options?: {
      createId?: () => string;
      defaultPolicy?: Policy<U, A, Operation, string, unknown>;
    }
  ) => AggregateConfigBuilder<U, A, BaseState, {}, true>;
  /**
   * Syncs events that failed to record
   *
   * @returns a promise that resolves when the sync is complete
   * @throws {StorageError} if the sync fails to persist event recording
   * @throws {UnauthorizedError} if the sync fails due to an authorization error
   */
  sync: () => Promise<void>;
  /**
   * Reset the event bus, delete all events from the repository, and reset the state of all stores
   * including deleting all aggregates from the corresponding repositories
   */
  reset: () => Promise<void>;
  /**
   * Cleanup the broker by unsubscribing from all subscriptions
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
  defaultPolicy?: Policy<U, string, Operation, string, unknown>;
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
    if (!eventServerAdapter || !(await authAdapter.getAccount())) return;
    const { res, err: recordError } = await tryCatch(() => eventServerAdapter.record(event));
    if (recordError) return;
    if (eventsRepository) {
      await eventsRepository.markRecorded(res.eventId, res.recordedAt, res.recordedBy);
    }
  };

  let activeSync: Promise<void> | null = null;
  const sync = async () => {
    // istanbul ignore next -- this doesn't need to be tested
    if (activeSync) return activeSync;
    activeSync = (async () => {
      if (eventsRepository && eventServerAdapter) {
        // store any unrecorded events
        const events = await eventsRepository.getUnrecorded();
        if (events.length) await Promise.all(events.map(recordEvent));
        // fetch any new events
        const lastRecordedEvent = await eventsRepository.getLastRecordedEvent();
        const { res: newEvents } = await tryCatch(() =>
          // istanbul ignore next -- don't need to test all undefined edge cases
          eventServerAdapter?.fetch(lastRecordedEvent?.id || null)
        );
        // istanbul ignore next -- don't need to test all undefined edge cases
        if (newEvents?.length && !eventBus.terminated) {
          newEvents.map((e) => eventBus.dispatch(e));
        }
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
      unsubscribeFromServerAdapter = eventServerAdapter.subscribe((event) => {
        if (!eventBus.terminated) eventBus.dispatch(event);
      });
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
      // istanbul ignore next -- unnecessary to test case without server adapter
      unsubscribeFromServerAdapter?.();
      periodicSyncSubscription.unsubscribe();
    };
  };
  let unsubscribe = initialize();

  const stores: AggregateStore<U, any, any, any>[] = [];
  const register = <
    A extends string,
    S extends BaseState,
    C extends {
      [fn: string]: AggregateCommandConfig<U, A, Operation, string, S, any>;
    }
  >(
    agg: AggregateConfig<U, A, S, C>
  ) => {
    const store = createStore(agg, { authAdapter, createId, eventsRepository, eventBus });
    stores.push(store);
    return store;
  };

  const aggBuilderCtx = createAggregateContext<U>({ createId, defaultPolicy });
  const aggregate = <A extends string>(
    aggregateType: A,
    options?: {
      createId?: () => string;
      defaultPolicy?: Policy<U, A, Operation, string, unknown>;
    }
  ) => aggBuilderCtx.aggregate(aggregateType, { ...options, register });

  const reset = async () => {
    unsubscribe();
    if (eventsRepository) await eventsRepository.deleteAll();
    eventBus.reset();
    await Promise.all(stores.map((store) => store.reset()));
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
