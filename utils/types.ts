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
  authPolicy: Policy<U, A, O, T, P>;
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

export type EventsRepository = {
  insert: (event: AnyAggregateEvent) => Promise<void>;
  reset: () => Promise<void>;
  markRecorded: (eventId: string, recordedAt: Date, recordedBy: string) => Promise<void>;
  getUnrecorded: () => Promise<AnyAggregateEvent[]>;
  getLastRecordedEvent: () => Promise<AnyAggregateEvent | null>;
};

