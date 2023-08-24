import { z } from 'zod';
import type { ZodSchema } from 'zod';
import type {
  AggregateRepository,
  AccountInterface,
  AggregateCommandConfig,
  BaseState,
  Operation,
  AggregateEvent,
  Policy,
  AggregateConfig,
} from '../utils/types';
import { mapObject } from '../utils/mapObject';

type AggregateCommandConfigBuilder<
  U extends AccountInterface,
  A extends string,
  O extends Operation,
  T extends string,
  S extends BaseState,
  P
> = AggregateCommandConfig<U, A, O, T, S, P> & {
  /**
   * Set the payload schema for the command
   *
   * @param schema the payload schema
   * @returns the command builder for chaining
   */
  payload: <Payload>(
    schema: ZodSchema<Payload>
  ) => AggregateCommandConfigBuilder<U, A, O, T, S, Payload>;
  /**
   * Set the policy that determines if the account is authorized to execute the command
   *
   * @param policy the policy function
   * @returns the command builder for chaining
   */
  policy: (
    policy: (account: U | null, event: AggregateEvent<A, O, `${A}_${T}`, P>) => boolean
  ) => AggregateCommandConfigBuilder<U, A, O, T, S, P>;
} & (O extends 'create'
    ? {
        /**
         * Set the function that constructs the initial state of the aggregate
         *
         * @param construct the constructor function
         * @returns the command builder for chaining
         */
        constructor: (
          construct: (payload: P) => Omit<S, keyof BaseState>
        ) => AggregateCommandConfigBuilder<U, A, O, T, S, P>;
      }
    : O extends 'update'
    ? {
        /**
         * Set the function that updates the state of the aggregate
         *
         * @param reduce the reducer function
         * @returns the command builder for chaining
         */
        reducer: (
          reduce: (payload: P, state: S) => Omit<S, keyof BaseState>
        ) => AggregateCommandConfigBuilder<U, A, O, T, S, P>;
      }
    : O extends 'delete'
    ? {
        /**
         * Set the function to call before deleting the aggregate
         *
         * @param destruct the destructor function
         * @returns the command builder for chaining
         */
        destructor: (
          destruct: (payload: P, state: S) => void
        ) => AggregateCommandConfigBuilder<U, A, O, T, S, P>;
      }
    : never);

type DefaultCommandsConfig<U extends AccountInterface, A extends string, S extends BaseState> = {
  create: AggregateCommandConfig<U, A, 'create', 'CREATED', S, Omit<S, keyof BaseState>>;
  update: AggregateCommandConfig<U, A, 'update', 'UPDATED', S, Partial<Omit<S, keyof BaseState>>>;
  delete: AggregateCommandConfig<U, A, 'delete', 'DELETED', S, undefined>;
};

type AggregateConfigBuilder<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  C extends { [fn: string]: AggregateCommandConfig<U, A, any, any, S, any> }
> = {
  config: AggregateConfig<U, A, S, C>;
  /**
   * Set the schema for the aggregate state
   *
   * @param schema the schema
   * @param options options for the schema setter
   * @returns the aggregate builder for chaining
   */
  schema: <
    State extends Omit<S, keyof BaseState>,
    D extends {
      /** indicates if default create, update, and delete commands should be defined based on the schema */
      createDefaultCommands: boolean;
    }
  >(
    schema: ZodSchema<State>,
    options?: D
  ) => AggregateConfigBuilder<
    U,
    A,
    State & BaseState,
    D['createDefaultCommands'] extends true
      ? DefaultCommandsConfig<U, A, State & BaseState>
      : { [fn: string]: AggregateCommandConfig<U, A, any, any, BaseState & State, any> }
  >;
  /**
   * Set the repository for persisting the aggregate state
   *
   * @param repository the repository
   * @returns the aggregate builder for chaining
   */
  repository: (repository: AggregateRepository<S>) => AggregateConfigBuilder<U, A, S, C>;
  /**
   * Set the commands for the aggregate
   *
   * @param maker a function that takes a command builder and returns a map of commands
   * @returns the aggregate builder for chaining
   */
  commands: <Commands extends { [fn: string]: AggregateCommandConfig<U, A, any, any, S, any> }>(
    maker: (
      command: <O extends Operation, T extends string>(
        eventType: T,
        operation: O
      ) => AggregateCommandConfigBuilder<U, A, O, T, S, unknown>
    ) => Commands
  ) => AggregateConfigBuilder<U, A, S, Commands>;
};

/**
 * Create an aggregate builder context
 *
 * @param ctx the context
 * @returns the aggregate builder context
 */
export const createAggregateContext = <U extends AccountInterface>(ctx: {
  createId?: () => string;
  defaultPolicy?: Policy<U, string, Operation, string, unknown>;
}) => {
  return {
    /**
     * Define an aggregate
     *
     * @param aggregateType the type of the aggregate
     * @param options options for the aggregate
     * @returns the aggregate builder for chaining
     */
    aggregate<A extends string>(
      aggregateType: A,
      options?: {
        createId?: () => string;
        defaultPolicy?: Policy<U, A, Operation, string, unknown>;
      }
    ): AggregateConfigBuilder<U, A, BaseState, {}> {
      /**
       * Define a command for the aggregate
       *
       * @param eventType the event type
       * @param operation the operation the command performs
       * @returns the command builder for chaining
       */
      const command = <O extends Operation, T extends string>(eventType: T, operation: O) => {
        // @ts-ignore -- we define action functions for each type of operation and throw an error if mismatched
        const cmdBuilder: AggregateCommandConfigBuilder<U, A, O, T, any, any> = {
          eventType,
          operation,
          authPolicy: options?.defaultPolicy ?? ctx.defaultPolicy,
          payload: <Payload>(schema: ZodSchema<Payload>) => {
            cmdBuilder.payloadSchema = schema;
            return cmdBuilder;
          },
          policy: (policy) => {
            cmdBuilder.authPolicy = policy;
            return cmdBuilder;
          },
          constructor: (constructor) => {
            // istanbul ignore next
            if (cmdBuilder.operation !== 'create') {
              throw new Error('Constructor is only valid for create operations');
            }
            cmdBuilder.construct = constructor;
            return cmdBuilder;
          },
          reducer: (reducer) => {
            // istanbul ignore next
            if (cmdBuilder.operation !== 'update') {
              throw new Error('Reducer is only valid for update operations');
            }
            cmdBuilder.reduce = reducer;
            return cmdBuilder;
          },
          destructor: (destructor) => {
            // istanbul ignore next
            if (cmdBuilder.operation !== 'delete') {
              throw new Error('Destructor is only valid for delete operations');
            }
            cmdBuilder.destruct = destructor;
            return cmdBuilder;
          },
        };
        return cmdBuilder;
      };

      // removes builder functions from the config and throws an error if any configurations are missing
      const parseCommandsConfig = (commandBuilders: {
        [fn: string]: AggregateCommandConfig<U, A, any, any, any, any>;
      }) => {
        return mapObject(
          commandBuilders,
          (
            { eventType, operation, authPolicy, payloadSchema, construct, reduce, destruct },
            key
          ) => {
            if (!authPolicy) {
              throw new Error(`missing policy definition for ${String(key)} command`);
            }
            if (!construct && operation === 'create') {
              throw new Error(`missing constructor definition for ${String(key)} command`);
            }
            if (!reduce && operation === 'update') {
              throw new Error(`missing reducer definition for ${String(key)} command`);
            }
            return {
              eventType,
              operation,
              authPolicy,
              payloadSchema,
              construct,
              reduce,
              destruct,
            };
          }
        );
      };

      const aggBuilder: AggregateConfigBuilder<U, A, any, any> = {
        config: {
          aggregateType,
          createId: options?.createId || ctx.createId,
          aggregateCommands: {},
        } as AggregateConfig<U, A, any, any>,
        schema: (schema, schemaOptions) => {
          if (aggBuilder.config.aggregateSchema) throw new Error('Schema already set');
          aggBuilder.config.aggregateSchema = schema;
          if (schemaOptions?.createDefaultCommands) {
            if (Object.keys(aggBuilder.config.aggregateCommands).length > 0) {
              throw new Error('Commands already set');
            }
            aggBuilder.config.aggregateCommands = parseCommandsConfig({
              create: command('CREATED', 'create')
                .payload(schema)
                .constructor((payload) => payload),
              update: command('UPDATED', 'update')
                // @ts-ignore -- zod can't infer that because S is an object ZodSchema<S> must be a ZodObject
                .payload(schema.partial() as ZodSchema<any>)
                .reducer((state, payload) => ({ ...state, ...payload })),
              delete: command('DELETED', 'delete').payload(z.undefined()),
            });
          }
          return aggBuilder;
        },
        repository: (repository) => {
          if (aggBuilder.config.aggregateRepository) throw new Error('Repository already set');
          aggBuilder.config.aggregateRepository = repository;
          return aggBuilder;
        },
        commands: (maker) => {
          if (Object.keys(aggBuilder.config.aggregateCommands).length > 0) {
            throw new Error('Commands already set');
          }
          aggBuilder.config.aggregateCommands = parseCommandsConfig(maker(command));
          return aggBuilder;
        },
      };
      return aggBuilder as AggregateConfigBuilder<U, A, BaseState, {}>;
    },
  };
};
