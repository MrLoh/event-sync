import { z, type ZodSchema } from 'zod';
import { BehaviorSubject } from 'rxjs';
import { mapObject } from '../utils/mapObject';
import { InvalidInputError, UnauthorizedError, NotFoundError } from '../utils/errors';

import type { EventBus } from './event-bus';
import type {
  AccountInterface,
  BaseState,
  AggregateEventConfig,
  Operation,
  AuthAdapter,
  EventsRepository,
  AggregateConfig,
  AggregateEventDispatchers,
  AggregateCommandsMaker,
  EventServerAdapter,
  AnyAggregateEvent,
} from '../utils/types';
import { tryCatch } from '../utils/result';

export type AggregateStore<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  E extends { [fn: string]: AggregateEventConfig<U, A, any, any, S, any> },
  C extends AggregateCommandsMaker<U, A, S, E>
> = Omit<AggregateEventDispatchers<U, A, S, E>, keyof ReturnType<C>> &
  ReturnType<C> & {
    /**
     * object containing the states of all aggregates keyed by id
     */
    state: { [id: string]: S };
    /**
     * subscribe to changes in the state of the aggregates
     *
     * @param fn the function to call when the state changes
     * @returns a function to unsubscribe
     */
    subscribe: (fn: (state: { [id: string]: S }) => void) => () => void;
    /**
     * record an event to the event server and, if successful, mark it as recorded in the events
     * repository, update the aggregate state and persist it in the aggregate repository
     *
     * @param event the event to record must have a matching aggregate type of the store
     */
    recordEvent: (event: AnyAggregateEvent) => Promise<void>;
    /**
     * Reset state of the aggregates to the initial state and delete all entries from the aggregate
     */
    reset: () => Promise<void>;
    /**
     * await this to ensure the store is initialized
     *
     * @remarks
     * it is not necessary to call this function to initialize the store, it's just a convenience to
     * await the initialization and take action when it's done.
     */
    initialize: () => Promise<void>;
    /**
     * indicates wether the store has been initialized
     */
    initialized: boolean;
  };

export const baseStateSchema: ZodSchema<BaseState> = z.object({
  id: z.string(),
  createdBy: z.string().optional(),
  createdOn: z.string(),
  lastEventId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  version: z.number(),
  lastRecordedAt: z.date().optional(),
});

/** will JSON stringify and parse to for example remove undefined values */
export const ensureEncodingSafety = <O extends Record<string, any>>(obj: O): O => {
  return JSON.parse(JSON.stringify(obj));
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
  C extends AggregateCommandsMaker<U, A, S, E>
>(
  aggBuilderOrConfig: AggregateConfig<U, A, S, E, C> | { config: AggregateConfig<U, A, S, E, C> },
  ctx: {
    /**
     * Method to generate an id for events, will be used as fallback for aggregates as well if no
     * createId function is specified in the aggregate config
     *
     * @returns a unique id
     */
    createId: () => string;
    /** The auth adapter to get device ids and accounts */
    authAdapter: AuthAdapter<U>;
    /** The main event bus */
    eventBus: EventBus;
    /** The repository for persisting events*/
    eventsRepository?: EventsRepository;
    /** The event server adapter to record events */
    eventServerAdapter?: EventServerAdapter;
  }
): AggregateStore<U, A, S, E, C> => {
  const agg = 'config' in aggBuilderOrConfig ? aggBuilderOrConfig.config : aggBuilderOrConfig;

  // setup aggregate state as a BehaviorSubject
  const collection$ = new BehaviorSubject<{ [id: string]: S }>({});

  // define the zod schema for the aggregate state
  const stateSchema = z.intersection(
    baseStateSchema,
    agg.aggregateSchema ?? z.any()
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

  const recordEvent = async (event: AnyAggregateEvent) => {
    if (event.recordedAt) return;
    if (event.aggregateType !== agg.aggregateType) {
      throw new Error(
        `${agg.aggregateType} store cannot record event for ${event.aggregateType} aggregate`
      );
    }
    if (!ctx.eventServerAdapter) return;
    const account = await ctx.authAdapter.getAccount();
    if (!account) return;
    // TODO: explicitly handle errors from server like authorization errors
    const { val: recordedEvent } = await tryCatch(() => ctx.eventServerAdapter!.record(event));
    if (!recordedEvent) return;
    await initialization;
    const currState = collection$.value[event.aggregateId];
    // ignore if aggregate state does not exist because it was deleted or there is a race condition
    if (event.operation !== 'delete' && currState) {
      const nextState = stateSchema.parse({
        ...currState,
        createdBy: currState.createdBy ?? recordedEvent.createdBy,
        lastRecordedAt: recordedEvent.recordedAt,
      } as S);
      collection$.next({ ...collection$.value, [event.aggregateId]: nextState });
      if (agg.aggregateRepository) {
        await agg.aggregateRepository.update(event.aggregateId, nextState);
      }
    }
    if (ctx.eventsRepository) {
      await ctx.eventsRepository.markRecorded(event.id, {
        recordedAt: recordedEvent.recordedAt,
        createdBy: recordedEvent.createdBy,
      });
    }
  };

  // process events for this aggregate from the event bus. This needs to be separate from the
  // event processing functions since events may come both from the application as well as from
  // the server.
  // TODO: identify synchronization conflicts and automatically resolve them by reapplying events in
  // a deterministic order.
  ctx.eventBus.subscribe(async (event) => {
    await initialization;
    const currStoreState = collection$.value;

    const eventByEventType = Object.values(agg.aggregateEvents).reduce(
      (acc, eventConfig) => ({
        ...acc,
        [eventConfig.eventType]: eventConfig,
      }),
      {} as { [eventType: string]: AggregateEventConfig<U, A, Operation, string, S, any> }
    );

    // TODO: add support for transactional commits
    const persistEventAndAggregate = async (state: S) => {
      try {
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
        if (!event.recordedAt) await recordEvent(event);
      } catch (e) {
        ctx.eventBus.terminate(e as Error);
        collection$.next(currStoreState);
      }
    };

    if (event.aggregateType !== agg.aggregateType) return;
    try {
      switch (event.operation) {
        case 'create': {
          const constructor = eventByEventType[event.type].construct;
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
          return await persistEventAndAggregate(state);
        }
        case 'update': {
          const reducer = eventByEventType[event.type].reduce;
          const currState = collection$.value[event.aggregateId];
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
          return await persistEventAndAggregate(nextState);
        }
        case 'delete': {
          const destructor = eventByEventType[event.type].destruct;
          const state = collection$.value[event.aggregateId];
          if (destructor) destructor(state, event.payload);
          const { [event.aggregateId]: _, ...rest } = currStoreState;
          collection$.next(rest);
          await persistEventAndAggregate(state);
          return await recordEvent(event);
        }
      }
    } catch (e) {
      ctx.eventBus.terminate(e as Error);
      collection$.next(currStoreState);
    }
  });

  // generate map of event dispatchers from event config which
  // 1. validates event payload,
  // 2. checks authorization, and
  // 3. adds metadata
  // and then dispatches the event to the event bus. The processing of events is handled by the
  // subscription to the event bus above.
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
            res.error
          );
        }
        payload = res.data;
      }
      const deviceId = await ctx.authAdapter.getDeviceId();
      const account = await ctx.authAdapter.getAccount();
      const event = {
        id: ctx.createId(),
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
      if (!eventConfig.authPolicy(account, event)) {
        throw new UnauthorizedError(
          `Account ${account?.id} is not authorized to dispatch event ${event.type}`
        );
      }
      // put event on event bus
      ctx.eventBus.dispatch(event);
    };

    switch (eventConfig.operation) {
      case 'create':
        return async (payload: any): Promise<string> => {
          await initialization;
          const id = (agg.createId ?? ctx.createId)();
          await dispatch(id, payload);
          return id;
        };
      case 'update':
      case 'delete':
        return async (id: string, payload?: any): Promise<void> => {
          await initialization;
          const currState = collection$.value[id];
          if (!currState) {
            throw new NotFoundError(`${agg.aggregateType} aggregate with id ${id} not found`);
          }
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
  ];
  if (restrictedProps.some((prop) => dispatchers.hasOwnProperty(prop))) {
    throw new Error(`events cannot have the following names: ${restrictedProps.join(', ')}`);
  }
  if (restrictedProps.some((prop) => commands.hasOwnProperty(prop))) {
    throw new Error(`commands cannot have the following names: ${restrictedProps.join(', ')}`);
  }

  return {
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
    recordEvent,
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
