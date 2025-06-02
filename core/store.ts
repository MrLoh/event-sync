import { BehaviorSubject } from 'rxjs';
import { z, type ZodSchema } from 'zod';

import { InvalidInputError, NotFoundError, UnauthorizedError } from '../utils/errors';
import { mapObject } from '../utils/mapObject';
import type {
  AccountInterface,
  AggregateCommandsMaker,
  AggregateConfig,
  AggregateEventConfig,
  AggregateEventDispatchers,
  AnyAggregateEvent,
  AnyRecordedAggregateEvent,
  AuthAdapter,
  BaseState,
  EventsRepository,
  Operation,
} from '../utils/types';
import type { EventBus } from './event-bus';

export type AggregateStore<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  E extends { [fn: string]: AggregateEventConfig<U, A, any, any, S, any> },
  C extends AggregateCommandsMaker<U, A, S, E>,
> = Omit<AggregateEventDispatchers<U, A, S, E>, keyof ReturnType<C>> &
  ReturnType<C> & {
    /**
     * Object containing the states of all aggregates keyed by id
     */
    state: { [id: string]: S };
    /**
     * Subscribe to changes in the state of the aggregates
     *
     * @param fn the function to call when the state changes
     * @returns a function to unsubscribe
     */
    subscribe: (fn: (state: { [id: string]: S }) => void) => () => void;
    /**
     * Apply an event to the aggregate store
     *
     * @remarks
     * This handles altering the aggregate state and persisting the aggregate state and event in the
     * corresponding repositories. If everything succeeded, it will dispatch the event on the event
     * bus. This is called both from the event creator functions as well as externally for events
     * that originated from other clients.
     *
     * @param event the event to processed
     * @returns true if the event was applied successfully, false if not
     */
    applyEvent: (event: AnyAggregateEvent) => Promise<void>;
    /**
     * Record an event to the event server and, if successful, mark it as recorded in the events
     * repository, update the aggregate state and persist it in the aggregate repository
     *
     * @param event the event to record must have a matching aggregate type of the store
     * @returns true if the event was recorded successfully, false if not
     */
    markRecorded: (event: AnyRecordedAggregateEvent) => Promise<void>;
    /**
     * Reset state of the aggregates to the initial state and delete all entries from the aggregate
     */
    reset: () => Promise<void>;
    /**
     * Await this to ensure the store is initialized
     *
     * @remarks
     * it is not necessary to call this function to initialize the store, it's just a convenience to
     * await the initialization and take action when it's done.
     */
    initialize: () => Promise<void>;
    /**
     * Indicates wether the store has been initialized
     */
    initialized: boolean;
  };

export const baseStateSchema: ZodSchema<BaseState> = z.object({
  id: z.string().nonempty(),
  createdBy: z.string().nonempty().optional(),
  createdOn: z.string().nonempty(),
  lastEventId: z.string().nonempty(),
  createdAt: z.date(),
  updatedAt: z.date(),
  version: z.number(),
  lastRecordedAt: z.date().optional(),
});

/** will JSON stringify and parse to for example remove undefined values */
export const ensureEncodingSafety = <O extends Record<string, any>>(obj: O): O => {
  return JSON.parse(JSON.stringify(obj), (_, value: unknown) =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      ? new Date(value)
      : value,
  );
};

/**
 * create a store for the given aggregate
 *
 * @param agg the aggregate configuration
 * @param ctx the context
 * @returns the aggregate store
 */
export const createStore = <
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  E extends { [fn: string]: AggregateEventConfig<U, A, Operation, string, S, any> },
  C extends AggregateCommandsMaker<U, A, S, E> = () => {},
>(
  aggBuilderOrConfig: AggregateConfig<U, A, S, E, C> | { config: AggregateConfig<U, A, S, E, C> },
  ctx: {
    /**
     * Method to generate an id for events, will be used as fallback for aggregates as well if no
     * create aggregate id function is specified in the aggregate config
     *
     * @returns a unique id
     */
    createEventId: () => string;
    /** The auth adapter to get device ids and accounts */
    authAdapter: AuthAdapter<U>;
    /** The main event bus */
    eventBus?: EventBus;
    /** The repository for persisting events*/
    eventsRepository?: EventsRepository;
  },
): AggregateStore<U, A, S, E, C> => {
  const agg = 'config' in aggBuilderOrConfig ? aggBuilderOrConfig.config : aggBuilderOrConfig;

  // setup aggregate state as a BehaviorSubject
  const collection$ = new BehaviorSubject<{ [id: string]: S }>({});

  // define the zod schema for the aggregate state
  const stateSchema = z.intersection(
    baseStateSchema,
    agg.aggregateSchema ?? z.any(),
  ) as ZodSchema<S>;

  // load the aggregate states from the repository
  let initialized = false;
  const initialization = (async () => {
    if (agg.aggregateRepository) {
      const repositoryState = await agg.aggregateRepository.getAll();
      if (Object.keys(repositoryState).length) collection$.next(repositoryState);
      initialized = true;
    }
  })();

  const eventByEventType = Object.values(agg.aggregateEvents).reduce(
    (acc, eventConfig) => ({
      ...acc,
      [eventConfig.eventType]: eventConfig,
    }),
    {} as { [eventType: string]: AggregateEventConfig<U, A, Operation, string, S, any> },
  );

  const markRecorded = async (event: AnyRecordedAggregateEvent) => {
    if (event.aggregateType !== agg.aggregateType) {
      throw new Error(
        `${agg.aggregateType} store cannot record event for ${event.aggregateType} aggregate`,
      );
    }
    await initialization;
    const currState = collection$.value[event.aggregateId];
    // ignore if aggregate state does not exist because it was deleted or there is a race condition
    if (currState) {
      const nextState = stateSchema.parse({
        ...currState,
        createdBy: currState.createdBy ?? event.createdBy,
        lastRecordedAt: event.recordedAt,
      } as S);
      collection$.next({ ...collection$.value, [event.aggregateId]: nextState });
      if (agg.aggregateRepository) {
        await agg.aggregateRepository.update(event.aggregateId, nextState);
      }
    }
    if (ctx.eventsRepository) {
      await ctx.eventsRepository.markRecorded(event.id, {
        recordedAt: event.recordedAt,
        createdBy: event.createdBy,
      });
    }
  };

  // Handle events for this aggregate which might come from a dispatcher or the server
  // 1. compute the next state of the effected aggregate
  // 2. persist the event and the aggregate state to repositories
  // 4. dispatch the event to the event bus
  // if something unexpectedly goes wrong it rolls back and terminates the event bus
  //
  // TODO: identify synchronization conflicts and automatically resolve them by reapplying events in
  // a deterministic order.
  const applyEvent = async (event: AnyAggregateEvent) => {
    await initialization;
    const currStoreState = collection$.value;

    // TODO: add support for transactional commits
    const persistAggregateAndPersistAndDispatchEvent = async (state: S) => {
      if (ctx.eventsRepository) await ctx.eventsRepository.create(event);
      if (agg.aggregateRepository) {
        if (event.operation === 'create') {
          await agg.aggregateRepository.create(state);
        } else if (event.operation === 'update') {
          return await agg.aggregateRepository.update(event.aggregateId, state);
        } else if (event.operation === 'delete') {
          return await agg.aggregateRepository.delete(event.aggregateId);
        }
      }
      if (ctx.eventBus) ctx.eventBus.dispatch(event);
    };

    if (event.aggregateType !== agg.aggregateType) {
      throw new Error(
        `${agg.aggregateType} store cannot apply event for ${event.aggregateType} aggregate`,
      );
    }
    if (event.operation !== 'create' && !currStoreState[event.aggregateId]) {
      throw new NotFoundError(`${event.aggregateType}:${event.aggregateId} not found`);
    }

    try {
      switch (event.operation) {
        case 'create': {
          const constructor = eventByEventType[event.type]!.construct;
          const state = stateSchema.parse({
            ...constructor!(event.payload),
            id: event.aggregateId,
            createdOn: event.createdOn,
            createdBy: event.createdBy,
            createdAt: event.dispatchedAt,
            updatedAt: event.dispatchedAt,
            lastEventId: event.id,
            lastRecordedAt: event.recordedAt,
            version: 1,
          } as S);
          collection$.next({ ...currStoreState, [event.aggregateId]: state });
          await persistAggregateAndPersistAndDispatchEvent(state);
          break;
        }
        case 'update': {
          const reducer = eventByEventType[event.type]!.reduce;
          const currState = collection$.value[event.aggregateId]!;
          const nextState: S = stateSchema.parse({
            ...currState,
            ...reducer!(currState, event.payload),
            id: event.aggregateId,
            createdOn: currState.createdOn,
            createdBy: currState.createdBy,
            createdAt: currState.createdAt,
            updatedAt: event.dispatchedAt,
            lastEventId: event.id,
            lastRecordedAt: event.recordedAt ?? currState.lastRecordedAt,
            version: currState.version + 1,
          });
          collection$.next({ ...currStoreState, [event.aggregateId]: nextState });
          await persistAggregateAndPersistAndDispatchEvent(nextState);
          break;
        }
        case 'delete': {
          const destructor = eventByEventType[event.type]!.destruct;
          const state = collection$.value[event.aggregateId]!;
          if (destructor) destructor(state, event.payload);
          const { [event.aggregateId]: _, ...rest } = currStoreState;
          collection$.next(rest);
          await persistAggregateAndPersistAndDispatchEvent(state);
          break;
        }
      }
    } catch (e) {
      if (ctx.eventBus) ctx.eventBus.terminate(e as Error);
      collection$.next(currStoreState);
    }
  };

  // generate map of event dispatchers from event config which
  // 1. validates event payload,
  // 2. checks authorization, and
  // 3. adds metadata
  // 4. call apply to update and persist the state
  const dispatchers = mapObject(agg.aggregateEvents, (eventConfig) => {
    const dispatch = async (aggregateId: string, payload: any, lastEventId?: string) => {
      // generate event
      if (payload) {
        payload = ensureEncodingSafety(payload);
      }
      if (eventConfig.payloadSchema) {
        const res = eventConfig.payloadSchema.safeParse(payload);
        if (!res.success) {
          throw new InvalidInputError(
            `Invalid payload for event ${eventConfig.eventType}`,
            res.error,
          );
        }
        payload = res.data;
      }
      const deviceId = await ctx.authAdapter.getDeviceId();
      const account = await ctx.authAdapter.getAccount();
      const event = {
        id: ctx.createEventId(),
        operation: eventConfig.operation,
        aggregateType: agg.aggregateType,
        aggregateId,
        type: eventConfig.eventType,
        payload,
        createdBy: account?.id,
        createdOn: deviceId,
        dispatchedAt: new Date(),
        prevId: lastEventId,
      };
      // check authorization
      const state = collection$.value[aggregateId] ?? null;
      if (!eventConfig.dispatchPolicy(account, state, event)) {
        throw new UnauthorizedError(
          `Account ${account?.id} is not authorized to dispatch event ${event.type}`,
        );
      }
      // call the apply function
      await applyEvent(event);
    };

    switch (eventConfig.operation) {
      case 'create':
        return async (payload: any): Promise<string> => {
          await initialization;
          const id = (agg.createAggregateId ?? ctx.createEventId)();
          await dispatch(id, payload);
          return id;
        };
      case 'update':
      case 'delete':
        return async (id: string, payload?: any): Promise<void> => {
          await initialization;
          const currState = collection$.value[id];
          if (!currState) throw new NotFoundError(`${agg.aggregateType}:${id} not found`);
          await dispatch(id, payload, currState.lastEventId);
          return;
        };
    }
  }) as AggregateEventDispatchers<U, A, S, E>;

  const commands = (agg.aggregateCommandMaker?.({
    getState: () => collection$.value,
    events: dispatchers,
    ...ctx.authAdapter,
  }) ?? {}) as ReturnType<C>;

  // ensure events don't overwrite default store methods
  const restrictedProps = [
    'get',
    'subscribe',
    'reset',
    'initialize',
    'initialized',
    'markRecorded',
    'applyEvent',
    'state',
  ];
  if (restrictedProps.some((prop) => dispatchers.hasOwnProperty(prop))) {
    throw new Error(`events cannot have the following names: ${restrictedProps.join(', ')}`);
  }
  if (restrictedProps.some((prop) => commands.hasOwnProperty(prop))) {
    throw new Error(`commands cannot have the following names: ${restrictedProps.join(', ')}`);
  }

  return {
    markRecorded,
    applyEvent,
    get state() {
      return collection$.value;
    },
    subscribe: (fn: (state: { [id: string]: S }) => void): (() => void) => {
      return collection$.subscribe((s) => fn(s)).unsubscribe;
    },
    reset: async () => {
      await initialization;
      if (agg.aggregateRepository) await agg.aggregateRepository.deleteAll();
      collection$.next({});
    },
    initialize: () => {
      return initialization;
    },
    get initialized() {
      return initialized;
    },
    // spreading the event functions needs to be last because the getter doesn't work otherwise
    ...dispatchers,
    ...commands,
  };
};
