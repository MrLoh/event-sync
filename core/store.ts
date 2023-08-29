import { z, type ZodSchema } from 'zod';
import { BehaviorSubject } from 'rxjs';
import { mapObject } from '../utils/mapObject';
import { InvalidInputError, UnauthorizedError, NotFoundError } from '../utils/errors';

import type { EventBus } from './event-bus';
import type {
  AccountInterface,
  BaseState,
  AggregateCommandConfig,
  Operation,
  AuthAdapter,
  EventsRepository,
  AggregateConfig,
} from '../utils/types';

type AggregateCommandFunctions<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  C extends { [fn: string]: AggregateCommandConfig<U, A, Operation, string, S, any> }
> = {
  [F in keyof C]: C[F] extends AggregateCommandConfig<U, A, infer O, any, S, infer P>
    ? O extends 'create'
      ? P extends undefined
        ? () => Promise<S>
        : (payload: P) => Promise<string>
      : O extends 'update'
      ? P extends undefined
        ? (id: string) => Promise<void>
        : (id: string, payload: P) => Promise<void>
      : O extends 'delete'
      ? P extends undefined
        ? (id: string) => Promise<void>
        : (id: string, payload: P) => Promise<void>
      : never
    : never;
};

export type AggregateStore<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  C extends { [fn: string]: AggregateCommandConfig<U, A, any, any, S, any> }
> = AggregateCommandFunctions<U, A, S, C> & {
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
   * Mark an aggregate as recorded to set recorded by if undefined and last recorded by fields
   */
  markRecorded: (aggregateId: string, recordedAt: Date, recordedBy: string) => Promise<void>;
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

export const baseStateSchema = z.object({
  id: z.string(),
  createdBy: z.string().optional(),
  createdOn: z.string(),
  lastEventId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  version: z.number(),
  lastRecordedAt: z.date().optional(),
}) satisfies ZodSchema<BaseState>;

/** will JSON stringify and parse to for example remove undefined values */
const ensureEncodingSafety = <O extends Record<string, any>>(obj: O): O => {
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
  C extends {
    [fn: string]: AggregateCommandConfig<U, A, Operation, string, S, any>;
  }
>(
  agg: AggregateConfig<U, A, S, C>,
  ctx: {
    authAdapter: AuthAdapter<U>;
    createId: () => string;
    eventsRepository?: EventsRepository;
    eventBus: EventBus;
  }
): AggregateStore<U, A, S, C> => {
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

  // process events for this aggregate from the event bus. This needs to be separate from the
  // command processing functions since events may come both from the application as well as from
  // the server.
  // TODO: identify synchronization conflicts and automatically resolve them by reapplying events in
  // a deterministic order.
  ctx.eventBus.subscribe(async (event) => {
    await initialization;
    const currStoreState = collection$.value;

    const commandByEventType = Object.values(agg.aggregateCommands).reduce(
      (acc, cmd) => ({ ...acc, [`${agg.aggregateType}_${cmd.eventType}`]: cmd }),
      {} as { [eventType: string]: AggregateCommandConfig<U, A, Operation, string, S, any> }
    );

    // TODO: add support for transactional commits
    const persistEventAndAggregate = async (state: S) => {
      try {
        if (ctx.eventsRepository) await ctx.eventsRepository.insert(event);
        if (agg.aggregateRepository) {
          if (event.operation === 'create') {
            await agg.aggregateRepository.insert(event.aggregateId, state);
          } else if (event.operation === 'update') {
            return await agg.aggregateRepository.update(event.aggregateId, state);
          } else if (event.operation === 'delete') {
            return await agg.aggregateRepository.delete(event.aggregateId);
          }
        }
      } catch (e) {
        ctx.eventBus.terminate(e as Error);
        collection$.next(currStoreState);
      }
    };

    if (event.aggregateType !== agg.aggregateType) return;
    switch (event.operation) {
      case 'create': {
        const constructor = commandByEventType[event.type].construct;
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
        const reducer = commandByEventType[event.type].reduce;
        const currState = collection$.value[event.aggregateId];
        const nextState = stateSchema.parse({
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
        } satisfies S);
        collection$.next({ ...currStoreState, [event.aggregateId]: nextState });
        return await persistEventAndAggregate(nextState);
      }
      case 'delete': {
        const destructor = commandByEventType[event.type].destruct;
        const state = collection$.value[event.aggregateId];
        destructor?.(state, event.payload);
        const { [event.aggregateId]: _, ...rest } = currStoreState;
        collection$.next(rest);
        return await persistEventAndAggregate(state);
      }
      default:
        // istanbul ignore next
        throw new Error(`Invalid operation ${event.operation}`);
    }
  });

  // generate map of command functions from command config which
  // 1. validates event payload,
  // 2. checks authorization, and
  // 3. adds metadata
  // and than dispatches the event to the event bus. The processing of events is handled by the
  // subscription to the event bus above.
  const fns = mapObject(agg.aggregateCommands, (cmd) => {
    const dispatch = async (aggregateId: string, payload: any, lastEventId?: string) => {
      // generate event
      const type = `${agg.aggregateType}_${cmd.eventType}` as const;
      if (payload) {
        payload = ensureEncodingSafety(payload);
      }
      if (cmd.payloadSchema) {
        const res = cmd.payloadSchema.safeParse(payload);
        if (!res.success) {
          throw new InvalidInputError(`Invalid payload for command ${type}`, res.error);
        }
        payload = res.data;
      }
      const deviceId = await ctx.authAdapter.getDeviceId();
      const account = await ctx.authAdapter.getAccount();
      const event = {
        id: ctx.createId(),
        operation: cmd.operation,
        aggregateType: agg.aggregateType,
        aggregateId,
        type,
        payload,
        createdBy: account?.id,
        createdOn: deviceId,
        dispatchedAt: new Date(),
        prevId: lastEventId,
      };
      // check authorization
      if (!cmd.authPolicy(account, event)) {
        throw new UnauthorizedError(
          `Account ${account?.id} is not authorized to dispatch event ${event.type}`
        );
      }
      // put event on event bus
      ctx.eventBus.dispatch(event);
    };

    switch (cmd.operation) {
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
          await dispatch(id, payload, currState.lastEventId);
          return;
        };
      default:
        // istanbul ignore next
        throw new Error(`Invalid operation ${cmd.operation}`);
    }
  }) as AggregateCommandFunctions<U, A, S, C>;

  // ensure commands don't overwrite default store methods
  const restrictedProps = [
    'get',
    'subscribe',
    'reset',
    'initialize',
    'initialized',
    'markRecorded',
  ];
  if (restrictedProps.some((prop) => agg.aggregateCommands?.hasOwnProperty(prop))) {
    // istanbul ignore next
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
    markRecorded: async (aggregateId: string, recordedAt: Date, recordedBy: string) => {
      await initialization;
      const currState = collection$.value[aggregateId];
      if (!currState) throw new NotFoundError(`Aggregate with id ${aggregateId} not found`);
      const nextState = stateSchema.parse({
        ...currState,
        createdBy: currState.createdBy ?? recordedBy,
        lastRecordedAt: recordedAt,
      } as S);
      collection$.next({ ...collection$.value, [aggregateId]: nextState });
      if (agg.aggregateRepository) {
        await agg.aggregateRepository.update(aggregateId, nextState);
      }
    },
    initialize: () => {
      return initialization;
    },
    get initialized() {
      return initialized;
    },
    // spreading the command functions needs to be last because the getter doesn't work otherwise
    ...fns,
  };
};
