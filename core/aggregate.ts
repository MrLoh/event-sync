import { z } from 'zod';
import { mapObject } from '../utils/mapObject';

import type { ZodSchema } from 'zod';
import type {
  AggregateRepository,
  AccountInterface,
  AggregateEventConfig,
  BaseState,
  Operation,
  AggregateEvent,
  Policy,
  AggregateConfig,
} from '../utils/types';
import type { AggregateStore } from './store';

type AggregateEventConfigBuilder<
  U extends AccountInterface,
  A extends string,
  O extends Operation,
  T extends string | undefined,
  S extends BaseState,
  P
> = {
  /** The event config that is being constructed */
  config: {
    aggregateType: A;
    eventType: T;
    operation: O;
    authPolicy: Policy<U, P>;
    payloadSchema?: ZodSchema<P>;
  } & (O extends 'create'
    ? {
        construct: (payload: P) => Omit<S, keyof BaseState>;
        reduce?: undefined;
        destruct?: undefined;
      }
    : O extends 'update'
    ? {
        construct?: undefined;
        reduce: (state: S, payload: P) => Omit<S, keyof BaseState>;
        destruct?: undefined;
      }
    : O extends 'delete'
    ? {
        construct?: undefined;
        reduce?: undefined;
        destruct?: (state: S, payload: P) => void;
      }
    : never);
  /**
   * Set the type of the event
   *
   * @param type the name of the event
   * @returns the event builder for chaining
   */
  type: <Type extends string>(type: Type) => AggregateEventConfigBuilder<U, A, O, Type, S, P>;
  /**
   * Set the payload schema for the event
   *
   * @param schema the payload schema
   * @returns the event builder for chaining
   */
  payload: <Payload>(
    schema: ZodSchema<Payload>
  ) => AggregateEventConfigBuilder<U, A, O, T, S, Payload>;
  /**
   * Set the policy that determines if the account is authorized for the event
   *
   * @param policy the policy function
   * @returns the event builder for chaining
   */
  policy: (
    policy: (account: U | null, event: AggregateEvent<string, Operation, string, P>) => boolean
  ) => AggregateEventConfigBuilder<U, A, O, T, S, P>;
} & (O extends 'create'
  ? {
      /**
       * Set the function that constructs the initial state of the aggregate
       *
       * @param construct the constructor function
       * @returns the event builder for chaining
       */
      constructor: (
        construct: (payload: P) => Omit<S, keyof BaseState>
      ) => AggregateEventConfigBuilder<U, A, O, T, S, P>;
    }
  : O extends 'update'
  ? {
      /**
       * Set the function that updates the state of the aggregate
       *
       * @param reduce the reducer function
       * @returns the event builder for chaining
       */
      reducer: (
        reduce: (state: S, payload: P) => Omit<S, keyof BaseState>
      ) => AggregateEventConfigBuilder<U, A, O, T, S, P>;
    }
  : O extends 'delete'
  ? {
      /**
       * Set the function to call before deleting the aggregate
       *
       * @param destruct the destructor function
       * @returns the event builder for chaining
       */
      destructor: (
        destruct: (payload: P, state: S) => void
      ) => AggregateEventConfigBuilder<U, A, O, T, S, P>;
    }
  : never);

type DefaultEventsConfig<U extends AccountInterface, A extends string, S extends BaseState> = {
  create: AggregateEventConfig<U, A, 'create', `${A}.create`, S, Omit<S, keyof BaseState>>;
  update: AggregateEventConfig<U, A, 'update', `${A}.update`, S, Partial<Omit<S, keyof BaseState>>>;
  delete: AggregateEventConfig<U, A, 'delete', `${A}.delete`, S, undefined>;
};

export type AggregateConfigBuilder<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  C extends { [fn: string]: AggregateEventConfig<U, A, any, any, S, any> },
  registerable extends boolean = false
> = {
  /** The aggregate config that is being constructed */
  config: AggregateConfig<U, A, S, C>;
  /**
   * Set the schema for the aggregate state
   *
   * @param schema the schema
   * @param options options for the schema setter
   * @returns the aggregate builder for chaining
   */
  schema: <
    State extends object,
    SchemaOptions extends {
      /** indicates if default create, update, and delete events should be defined based on the schema */
      createDefaultEvents: boolean;
    }
  >(
    schema: ZodSchema<State>,
    options?: SchemaOptions
  ) => AggregateConfigBuilder<
    U,
    A,
    State & BaseState,
    SchemaOptions['createDefaultEvents'] extends true
      ? DefaultEventsConfig<U, A, State & BaseState>
      : { [fn: string]: AggregateEventConfig<U, A, any, any, BaseState & State, any> },
    registerable
  >;
  /**
   * Set the default policy that determines if the account is authorized for the event
   *
   * @param policy the default policy function
   * @returns the event builder for chaining
   */
  policy: (policy: Policy<U, unknown>) => AggregateConfigBuilder<U, A, S, C, registerable>;
  /**
   * Set the repository for persisting the aggregate state
   *
   * @param repository the repository
   * @returns the aggregate builder for chaining
   */
  repository: (
    repository: AggregateRepository<S>
  ) => AggregateConfigBuilder<U, A, S, C, registerable>;
  /**
   * Set the events for the aggregate
   *
   * @param maker a function that takes a event builder and returns a map of events
   * @returns the aggregate builder for chaining
   */
  events: <
    Events extends {
      [fn: string]: { config: AggregateEventConfigBuilder<U, A, any, any, S, any>['config'] };
    }
  >(
    maker: (
      event: <O extends Operation>(
        operation: O
      ) => AggregateEventConfigBuilder<U, A, O, undefined, S, undefined>
    ) => Events
  ) => AggregateConfigBuilder<
    U,
    A,
    S,
    {
      [K in keyof Events]: Events[K]['config'] extends AggregateEventConfigBuilder<
        U,
        A,
        infer O,
        infer T,
        S,
        infer P
      >['config']
        ? AggregateEventConfig<
            U,
            A,
            O,
            T extends undefined ? (K extends string ? `${A}.${K}` : never) : T,
            S,
            P
          >
        : never;
    },
    registerable
  >;
} & (registerable extends true
  ? {
      /**
       * Registers the aggregate config to the broker to create a store
       *
       * @returns the aggregate store
       */
      register: () => AggregateStore<U, A, S, C>;
    }
  : {});

/**
 * Create an aggregate builder context
 *
 * @param ctx the context
 * @returns the aggregate builder context
 */
export const createContext = <U extends AccountInterface>(
  ctx: {
    createId?: () => string;
    defaultPolicy?: Policy<U, unknown>;
  } = {}
): {
  aggregate: <
    A extends string,
    R extends
      | ((config: AggregateConfig<U, A, any, any>) => AggregateStore<U, A, any, any>)
      | undefined
  >(
    aggregateType: A,
    options?: {
      createId?: () => string;
      register?: R;
    }
  ) => AggregateConfigBuilder<U, A, BaseState, {}, R extends undefined ? false : true>;
} => {
  let defaultPolicy = ctx.defaultPolicy;
  return {
    /**
     * Define an aggregate
     *
     * @param aggregateType the type of the aggregate
     * @param options options for the aggregate
     * @returns the aggregate builder for chaining
     */
    aggregate: <
      A extends string,
      R extends
        | ((config: AggregateConfig<U, A, any, any>) => AggregateStore<U, A, any, any>)
        | undefined
    >(
      aggregateType: A,
      options?: {
        createId?: () => string;
        register?: R;
      }
    ) => {
      /**
       * Define a event for the aggregate
       *
       * @param eventType the event type
       * @param operation the operation the event performs
       * @returns the event builder for chaining
       */
      const event = <O extends Operation>(operation: O) => {
        // @ts-ignore -- we define action functions for each type of operation and throw an error if mismatched
        const eventBuilder: AggregateEventConfigBuilder<U, A, O, T, any, any> = {
          config: {
            aggregateType,
            operation,
            authPolicy: defaultPolicy,
            payloadSchema: operation === 'delete' ? z.undefined() : undefined,
          },
          type: (type) => {
            eventBuilder.config.eventType = type;
            return eventBuilder;
          },
          payload: <Payload>(schema: ZodSchema<Payload>) => {
            eventBuilder.config.payloadSchema = schema;
            return eventBuilder;
          },
          policy: (policy) => {
            eventBuilder.config.authPolicy = policy;
            return eventBuilder;
          },
          constructor: (constructor) => {
            // istanbul ignore next
            if (eventBuilder.config.operation !== 'create') {
              throw new Error('Constructor is only valid for create operations');
            }
            eventBuilder.config.construct = constructor;
            return eventBuilder;
          },
          reducer: (reducer) => {
            // istanbul ignore next
            if (eventBuilder.config.operation !== 'update') {
              throw new Error('Reducer is only valid for update operations');
            }
            eventBuilder.config.reduce = reducer;
            return eventBuilder;
          },
          destructor: (destructor) => {
            // istanbul ignore next
            if (eventBuilder.config.operation !== 'delete') {
              throw new Error('Destructor is only valid for delete operations');
            }
            eventBuilder.config.destruct = destructor;
            return eventBuilder;
          },
        };
        return eventBuilder;
      };

      // extract config from builder functions and throws an error if any configuration is missing
      const parseEventsConfig = (eventBuilders: {
        [fn: string]: { config: AggregateEventConfigBuilder<U, A, any, any, any, any>['config'] };
      }) => {
        return mapObject(eventBuilders, ({ config }, key) => {
          if (!config.authPolicy) {
            throw new Error(`missing policy definition for ${String(key)} event`);
          }
          if (!config.construct && config.operation === 'create') {
            throw new Error(`missing constructor definition for ${String(key)} event`);
          }
          if (!config.reduce && config.operation === 'update') {
            throw new Error(`missing reducer definition for ${String(key)} event`);
          }
          if (config.eventType === undefined) {
            config.eventType = `${aggregateType}.${key}`;
          }
          return config;
        });
      };

      const aggBuilder: AggregateConfigBuilder<U, A, any, any> = {
        config: {
          aggregateType: aggregateType,
          createId: options?.createId || ctx.createId,
          aggregateEvents: {},
          defaultAuthPolicy: ctx.defaultPolicy,
        } as AggregateConfig<U, A, any, any>,
        schema: (schema, schemaOptions) => {
          if (aggBuilder.config.aggregateSchema) throw new Error('Schema already set');
          aggBuilder.config.aggregateSchema = schema;
          if (schemaOptions?.createDefaultEvents) {
            if (Object.keys(aggBuilder.config.aggregateEvents).length > 0) {
              throw new Error('Events already set');
            }
            aggBuilder.config.aggregateEvents = parseEventsConfig({
              create: event('create')
                .payload(schema)
                .constructor((payload) => payload),
              update: event('update')
                // @ts-ignore -- zod can't infer that because S is an object ZodSchema<S> must be a ZodObject
                .payload(schema.partial() as ZodSchema<any>)
                .reducer((state, payload) => ({ ...state, ...payload })),
              delete: event('delete').payload(z.undefined()),
            });
          }
          return aggBuilder;
        },
        policy: (policy) => {
          if (
            aggBuilder.config.defaultAuthPolicy &&
            aggBuilder.config.defaultAuthPolicy !== ctx.defaultPolicy
          ) {
            throw new Error('Policy already set');
          }
          aggBuilder.config.defaultAuthPolicy = policy;
          defaultPolicy = policy;
          return aggBuilder;
        },
        repository: (repository) => {
          if (aggBuilder.config.aggregateRepository) throw new Error('Repository already set');
          aggBuilder.config.aggregateRepository = repository;
          return aggBuilder;
        },
        events: (maker) => {
          if (Object.keys(aggBuilder.config.aggregateEvents).length > 0) {
            throw new Error('Events already set');
          }
          aggBuilder.config.aggregateEvents = parseEventsConfig(maker(event));
          return aggBuilder;
        },
      };
      if (options?.register) {
        const { register } = options;
        // @ts-ignore -- we cast aggBuilder later to the correct type
        aggBuilder.register = () => {
          return register(aggBuilder.config);
        };
      }

      return aggBuilder as AggregateConfigBuilder<
        U,
        A,
        BaseState,
        {},
        R extends undefined ? false : true
      >;
    },
  };
};

/** Extract the union of event types from an aggregate config */
export type AggregateEventTypeFromConfig<
  C extends {
    aggregateEvents: {
      [fn: string]: AggregateEventConfig<any, any, any, any, any, any>;
    };
  }
> = {
  [F in keyof C['aggregateEvents']]: C['aggregateEvents'][F] extends AggregateEventConfig<
    any,
    infer A,
    infer O,
    infer T,
    any,
    infer P
  >
    ? AggregateEvent<A, O, T, P>
    : never;
}[keyof C['aggregateEvents']];
