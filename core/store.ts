import { z, ZodSchema } from 'zod';
import { BehaviorSubject } from 'rxjs';
import { mapObject } from '../utils/mapObject';
import { InvalidInputError, UnauthorizedError } from '../utils/errors';

import type { EventBus } from './event-bus';
import type {
  AccountInterface,
  BaseState,
  AggregateCommandConfig,
  AggregateCommandFunctions,
  Operation,
  AuthAdapter,
  EventsRepository,
} from '../utils/types';

export type AggregateRepository<S> = {
  /**
   * get the state of the aggregate with the given id
   *
   * @param id the id of the aggregate
   * @returns promise of the state of the aggregate
   */
  getOne: (id: string) => Promise<S>;
  /**
   * get states of all aggregates
   *
   * @returns promise of states of all aggregates keyed by id
   */
  getAll: () => Promise<{ [id: string]: S }>;
  /**
   * insert a new aggregate with the given state and id
   *
   * @param id the id of the aggregate
   * @param state the state of the aggregate
   */
  insert: (id: string, state: S) => Promise<void>;
  /**
   * update the state of the aggregate with the given id
   *
   * @param id the id of the aggregate
   * @param state the state of the aggregate
   */
  update: (id: string, state: S) => Promise<void>;
  /**
   * delete the state of the aggregate with the given id
   *
   * @param id the id of the aggregate
   */
  delete: (id: string) => Promise<void>;
  /**
   * delete all aggregates in the repository
   */
  deleteAll: () => Promise<void>;
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
   * reset the state of the aggregates to the initial state
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
  updatedAt: z.date().optional(),
  version: z.number(),
});

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
  agg: {
    aggregateType: A;
    aggregateSchema?: ZodSchema<Omit<S, keyof BaseState>>;
    repository?: AggregateRepository<S>;
    commands?: C;
    createId?: () => string;
  },
  ctx: {
    authAdapter: AuthAdapter<U>;
    createId: () => string;
    eventsRepository?: EventsRepository;
    eventBus: EventBus;
  }
): AggregateStore<U, A, S, C> => {
  const collection$ = new BehaviorSubject<{ [id: string]: S }>({});

  const stateSchema = z.intersection(
    baseStateSchema,
    agg.aggregateSchema ?? z.any()
  ) as ZodSchema<S>;

  const commandByEventType = Object.values(agg.commands ?? {}).reduce(
    (acc, cmd) => ({ ...acc, [`${agg.aggregateType}_${cmd.eventType}`]: cmd }),
    {} as { [eventType: string]: AggregateCommandConfig<U, A, Operation, string, S, any> }
  );

  // load the aggregate states from the repository
  let initialized = false;
  const initialization = (async () => {
    if (agg.repository) {
      const repositoryState = await agg.repository.getAll();
      if (Object.keys(repositoryState).length) collection$.next(repositoryState);
      initialized = true;
    }
  })();

  ctx.eventBus.subscribe(async (event) => {
    await initialization;
    const currStoreState = collection$.value;

    // TODO: add support for transactional commits
    const persistEventAndAggregate = async (state: S) => {
      try {
        if (ctx.eventsRepository) await ctx.eventsRepository.insert(event);
        if (agg.repository) {
          if (event.operation === 'create') {
            await agg.repository.insert(event.aggregateId, state);
          } else if (event.operation === 'update') {
            return await agg.repository.update(event.aggregateId, state);
          } else if (event.operation === 'delete') {
            return await agg.repository.delete(event.aggregateId);
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

  const fns = mapObject(agg.commands ?? ({} as C), (cmd) => {
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
        createdBy: deviceId,
        createdOn: account?.id,
        dispatchedAt: new Date(),
        prevId: lastEventId,
      };
      // check authorization
      if (!cmd.policy(account, event)) {
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
  const restrictedProps = ['get', 'subscribe', 'reset', 'initialize', 'initialized'];
  if (restrictedProps.some((prop) => agg.commands?.hasOwnProperty(prop))) {
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
      if (agg.repository) await agg.repository.deleteAll();
      collection$.next({});
    },
    initialize: () => {
      return initialization;
    },
    get initialized() {
      return initialized;
    },
    ...fns,
  };
};
