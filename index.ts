import { BehaviorSubject, Subject, filter, interval, throttleTime, merge } from 'rxjs';

import { InvalidInputError, StorageError, UnauthorizedError } from './errors';

const tryCatch = async <T>(
  fn: () => T
): Promise<{ res: undefined; err: Error } | { res: Awaited<T>; err: undefined }> => {
  try {
    const res = await fn();
    return { res, err: undefined };
  } catch (err: any) {
    if (!(err instanceof Error)) err = new Error(`Unexpected throw value: ${err}`);
    return { res: undefined, err };
  }
};

export type AggregateEvent<A> = {
  id: string;
  aggregateType: A;
  aggregateId: string;
  type: string;
  payload: any;
  dispatchedAt: Date;
  createdBy?: string;
  createdOn?: string;
  prevId?: string;
  recordedAt?: Date;
};

export interface EventsRepository {
  insert: (event: AggregateEvent<any>) => Promise<void>;
  reset: () => Promise<void>;
  markRecorded: (eventId: string, recordedAt: Date, recordedBy: string) => Promise<void>;
  getUnrecorded: () => Promise<AggregateEvent<any>[]>;
  getLastRecordedEvent: () => Promise<AggregateEvent<any> | null>;
}

export interface EventServerAdapter {
  record: (
    event: AggregateEvent<any>
  ) => Promise<{ eventId: string; recordedAt: Date; recordedBy: string }>;
  fetch: (lastRecordedEventId: string | null) => Promise<AggregateEvent<any>[]>;
  subscribe: (subscriber: (event: AggregateEvent<any>) => void) => () => void;
}

export interface AggregateRepository<S> {
  get: () => Promise<S>;
  set: (state: S) => Promise<void>;
  reset: () => Promise<S>;
}

export interface ConnectionStatusAdapter {
  listen: (callback: (connected: boolean | null) => void) => void;
  check: () => Promise<boolean | null>;
}

export interface AuthAdapter<R extends string> {
  getAccount: () => Promise<{ id: string; roles: R[] } | null>;
  onLogin: (callback: () => void) => void;
  onLogout: (callback: () => void) => void;
  getDeviceId: () => Promise<string>;
}

type AggregateStore<S> = {
  get: () => Promise<S>;
  subscribe: (callback: (state: S) => void) => Promise<() => void>;
  dispatch: <T extends string, P>(aggregateId: string, type: T, payload: P) => Promise<void>;
  destroy: () => Promise<void>;
  reset: () => Promise<void>;
};

/**
 * Creates an event broker
 *
 * @param config the configuration for the broker
 * @returns a broker object with methods to register stores
 */
export const createBroker = <R extends string>({
  eventsRepository,
  eventServerAdapter,
  connectionStatusAdapter,
  authAdapter,
  createId,
  retrySyncInterval = 5 * 60 * 1000,
}: {
  eventsRepository?: EventsRepository;
  eventServerAdapter?: EventServerAdapter;
  connectionStatusAdapter?: ConnectionStatusAdapter;
  authAdapter: AuthAdapter<R>;
  createId: () => string;
  retrySyncInterval?: number;
}) => {
  const subscriptions = [] as { unsubscribe: () => void }[];
  const stores = {} as Record<string, AggregateStore<any>>;

  /** the main event queue */
  const event$ = new Subject<AggregateEvent<any>>();

  const connected$ = new BehaviorSubject(false);
  if (connectionStatusAdapter) {
    connectionStatusAdapter.check().then((connected) => {
      if (connected !== null) connected$.next(connected);
    });
    connectionStatusAdapter.listen((connected) => {
      if (connected !== null) connected$.next(connected);
    });
  } else {
    connected$.next(true);
  }

  const recordEvent = async (event: AggregateEvent<any>) => {
    if (!eventServerAdapter || !(await authAdapter.getAccount())) return;
    const { res, err: recordError } = await tryCatch(() => eventServerAdapter.record(event));
    if (recordError) return;
    if (!eventsRepository) return;
    const { err: markRecordedError } = await tryCatch(() =>
      eventsRepository.markRecorded(res.eventId, res.recordedAt, res.recordedBy)
    );
    if (markRecordedError) {
      throw new StorageError('Failed to mark event as recorded', markRecordedError);
    }
  };

  let activeSync: Promise<void> | null = null;
  /**
   * Syncs events that failed to record
   *
   * @returns a promise that resolves when the sync is complete
   * @throws {StorageError} if the sync fails to persist event recording
   * @throws {UnauthorizedError} if the sync fails due to an authorization error
   */
  const sync = async () => {
    if (activeSync) return activeSync;
    activeSync = (async () => {
      if (eventsRepository && eventServerAdapter) {
        // store any unrecorded events
        const { res: events } = await tryCatch(() => eventsRepository.getUnrecorded());
        if (events?.length) await Promise.all(events.map(recordEvent));
        // fetch any new events
        const lastRecordedEvent = await eventsRepository.getLastRecordedEvent();
        const { res: newEvents } = await tryCatch(() =>
          eventServerAdapter?.fetch(lastRecordedEvent?.id || null)
        );
        if (newEvents?.length) newEvents.map((e) => event$.next(e));
      }
      activeSync = null;
    })();
  };

  // subscribe to server events
  if (eventServerAdapter) {
    const unsubscribe = eventServerAdapter.subscribe((event) => {
      event$.next(event);
    });
    subscriptions.push({ unsubscribe });
  }
  // subscribe to auth changes
  authAdapter.onLogin(() => sync());
  authAdapter.onLogout(async () => {
    await Promise.all(Object.values(stores).map((store) => store.reset()));
    await eventsRepository?.reset();
  });

  // try recording events initially
  subscriptions.push(event$.pipe(filter((e) => !e.recordedAt)).subscribe(recordEvent));
  // replay events that failed to record
  subscriptions.push(
    merge(connected$.pipe(filter(Boolean)), interval(retrySyncInterval))
      .pipe(throttleTime(retrySyncInterval / 5))
      .subscribe(sync)
  );

  /**
   * Registers a new aggregate store
   *
   * @param aggregateType the type of aggregate
   * @param config the configuration for the aggregate
   * @returns a store object with methods to dispatch events and subscribe to state changes
   */
  const registerStore = <A extends string, S, E extends AggregateEvent<A>>(
    aggregateType: A,
    {
      reducer,
      authorizer,
      parseEvent,
      selectLastEventId,
      repository,
    }: {
      reducer: (state: S, event: E) => S;
      parseEvent: (event: any) => E;
      authorizer: (event: E, account?: { id: string; roles: R[] } | null) => boolean;
      selectLastEventId: (state: S, aggregateId: string) => string;
      repository: AggregateRepository<S>;
    }
  ) => {
    const initialization = (async () => {
      let destroyed = false;
      const state = await repository.get();
      const aggregateState$ = new BehaviorSubject<S>(state);
      const processEventsSubscription = event$
        .pipe(filter((event): event is E => event.aggregateType === aggregateType))
        .subscribe(async (event) => {
          // update state
          const state = aggregateState$.getValue();
          const nextState = reducer(state, event);
          aggregateState$.next(nextState);
        });
      const persistStateSubscription = aggregateState$.subscribe(async (state) => {
        await repository.set(state);
      });
      return {
        destroy: () => {
          processEventsSubscription.unsubscribe();
          persistStateSubscription.unsubscribe();
          aggregateState$.complete();
          destroyed = true;
        },
        get aggregateState$() {
          if (destroyed) throw new Error('Cannot dispatch events after store is destroyed');
          return aggregateState$;
        },
      };
    })();

    /**
     * Removes all subscriptions and prevents new interactions with the store
     */
    const destroy = async () => {
      (await initialization).destroy();
    };

    /**
     * Resets the store to the initial state
     */
    const reset = async () => {
      const { aggregateState$ } = await initialization;
      const state = await repository.reset();
      aggregateState$.next(state);
    };

    /**
     * Dispatches an event to the store to update it's state
     *
     * @param aggregateId the aggregate id the event is for
     * @param type the event type
     * @param payload the event payload
     * @throws if the store has been destroyed
     */
    const dispatch = async <T extends Parameters<typeof authorizer>[0]['type']>(
      aggregateId: string,
      type: T,
      payload: Extract<E, { type: T }>['payload']
    ) => {
      const { aggregateState$ } = await initialization;

      // construct event
      const account = await authAdapter.getAccount();
      const deviceId = await authAdapter.getDeviceId();
      const { res: event, err: parseError } = await tryCatch(() =>
        parseEvent({
          aggregateType,
          aggregateId,
          type,
          payload,
          id: createId(),
          createdBy: account?.id,
          createdOn: deviceId,
          dispatchedAt: new Date(),
          prevId: selectLastEventId(aggregateState$.getValue(), aggregateId),
        })
      );
      if (parseError) throw new InvalidInputError(`Invalid payload for event ${type}`, parseError);

      // check authorization for event
      if (!authorizer(event, account)) {
        throw new UnauthorizedError(
          `Account ${account?.id} is not authorized to dispatch event ${type}}`
        );
      }

      // persist event
      if (eventsRepository) {
        const { err: insertError } = await tryCatch(() => eventsRepository.insert(event));
        if (insertError) {
          throw new StorageError(`Error storing event ${type}`, insertError as Error);
        }
      }

      // put event on queue
      event$.next(event);
    };

    /**
     * Subscribes to state changes
     * @param subscriber the subscriber function
     * @returns promise with a function to unsubscribe
     * @throws if the store has been destroyed
     *
     * @example
     * const unsubscribe = store.subscribe((state) => {
     *  console.log(state);
     * });
     * // later
     * unsubscribe();
     */
    const subscribe = async (subscriber: (value: S) => void): Promise<() => void> => {
      const { aggregateState$ } = await initialization;
      const subscription = aggregateState$.subscribe(subscriber);
      return () => subscription.unsubscribe();
    };

    /**
     * Gets the current state
     *
     * @returns the current state
     * @throws if the store has been destroyed
     */
    const get = async (): Promise<S> => {
      const { aggregateState$ } = await initialization;
      return aggregateState$.getValue();
    };

    const store = { dispatch, subscribe, get, destroy, reset };
    stores[aggregateType] = store;
    return store;
  };

  const cleanup = async () => {
    await Promise.all([
      ...subscriptions.map((subscription) => subscription.unsubscribe()),
      ...Object.values(stores).map((store) => store.destroy()),
    ]);
  };
  return { registerStore, sync, cleanup, event$ };
};
