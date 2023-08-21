import type { ZodSchema } from 'zod';

export type Operation = 'create' | 'update' | 'delete';

export type AggregateEvent<A extends string, O extends Operation, T extends string, P> = {
  id: string;
  operation: O;
  aggregateType: A;
  aggregateId: string;
  type: T;
  payload: P;
  dispatchedAt: Date;
  createdBy?: string;
  createdOn?: string;
  prevId?: string;
  recordedAt?: Date;
};

export type AnyAggregateEvent = AggregateEvent<string, Operation, string, any>;

export type AccountInterface = { id: string };

export type AuthAdapter<U extends AccountInterface> = {
  getDeviceId: () => Promise<string>;
  getAccount: () => Promise<U | null>;
};

export type BaseState = {
  id: string;
  createdBy?: string;
  createdOn: string;
  lastEventId: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type Policy<
  U extends AccountInterface,
  A extends string,
  O extends Operation,
  T extends string,
  P
> = (account: U | null, event: AggregateEvent<A, O, `${A}_${T}`, P>) => boolean;

export type AggregateCommandConfig<
  U extends AccountInterface,
  A extends string,
  O extends Operation,
  T extends string,
  S extends BaseState,
  P
> = {
  eventType: T;
  operation: O;
  policy: Policy<U, A, O, T, P>;
  payloadSchema: ZodSchema<P>;
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

export type AggregateCommandFunctions<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  C extends { [fn: string]: AggregateCommandConfig<U, A, Operation, string, S, any> }
> = {
  [F in keyof C]: C[F] extends AggregateCommandConfig<U, A, infer O, string, S, infer P>
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
    : 'never';
};

export type EventsRepository = {
  insert: (event: AnyAggregateEvent) => Promise<void>;
  reset: () => Promise<void>;
  markRecorded: (eventId: string, recordedAt: Date, recordedBy: string) => Promise<void>;
  getUnrecorded: () => Promise<AnyAggregateEvent[]>;
  getLastRecordedEvent: () => Promise<AnyAggregateEvent | null>;
};

