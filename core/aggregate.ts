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
} from '../utils/types';
import { mapObject } from '../utils/mapObject';

type AggregateConfig<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  C extends {
    [fn: string]: AggregateCommandConfig<U, A, Operation, string, S, any>;
  }
> = {
  aggregateType: A;
  aggregateSchema?: ZodSchema<Omit<S, keyof BaseState>>;
  aggregateRepository?: AggregateRepository<S>;
  aggregateCommands: C;
  createId?: () => string;
};

type AggregateCommandConfigBuilder<
  U extends AccountInterface,
  A extends string,
  O extends Operation,
  T extends string,
  S extends BaseState,
  P
> = AggregateCommandConfig<U, A, O, T, S, P> & {
  payload: <Payload>(
    schema: ZodSchema<Payload>
  ) => AggregateCommandConfigBuilder<U, A, O, T, S, Payload>;
  policy: (
    policy: (account: U | null, event: AggregateEvent<A, O, `${A}_${T}`, P>) => boolean
  ) => AggregateCommandConfigBuilder<U, A, O, T, S, P>;
} & (O extends 'create'
    ? {
        constructor: (
          construct: (payload: P) => Omit<S, keyof BaseState>
        ) => AggregateCommandConfigBuilder<U, A, O, T, S, P>;
      }
    : O extends 'update'
    ? {
        reducer: (
          reduce: (payload: P, state: S) => Omit<S, keyof BaseState>
        ) => AggregateCommandConfigBuilder<U, A, O, T, S, P>;
      }
    : O extends 'delete'
    ? {
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
  schema: <State extends Omit<S, keyof BaseState>, D extends { createDefaultCommands: boolean }>(
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
  repository: (repository: AggregateRepository<S>) => AggregateConfigBuilder<U, A, S, C>;
  commands: <Commands extends { [fn: string]: AggregateCommandConfig<U, A, any, any, S, any> }>(
    maker: (
      command: <O extends Operation, T extends string>(
        eventType: T,
        operation: O
      ) => AggregateCommandConfigBuilder<U, A, O, T, S, unknown>
    ) => Commands
  ) => AggregateConfigBuilder<U, A, S, Commands>;
};

export const createAggregateContext = <U extends AccountInterface>(ctx: {
  createId?: () => string;
  defaultPolicy?: Policy<U, string, Operation, string, unknown>;
}) => {
  return {
    aggregate<A extends string>(
      aggregateType: A,
      options?: {
        createId?: () => string;
        defaultPolicy?: Policy<U, A, Operation, string, unknown>;
      }
    ): AggregateConfigBuilder<U, A, BaseState, {}> {
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
