import type { ZodSchema } from 'zod';

export type Operation = 'create' | 'update' | 'delete';

export type AggregateEvent<A extends string, O extends Operation, T extends string, P> = {
  /** The id of the event */
  id: string;
  /** The operation that was performed */
  operation: O;
  /** The type of the aggregate */
  aggregateType: A;
  /** The id of the aggregate */
  aggregateId: string;
  /** The type of the event */
  type: T;
  /** The payload of the event */
  payload: P;
  /** The date-time the event was dispatched at */
  dispatchedAt: Date;
  /** The id of the account that dispatched the event */
  createdBy?: string;
  /** The id of the device that dispatched the event */
  createdOn?: string;
  /** The id of the previous event */
  prevId?: string;
  /** The date-time the event was recorded at on the server */
  recordedAt?: Date;
};

export type AnyAggregateEvent = AggregateEvent<string, Operation, string, any>;

export type EventsRepository = {
  /**
   * Insert a new event into the repository
   *
   * @param event the event to insert
   */
  insert: (event: AnyAggregateEvent) => Promise<void>;
  /**
   * Reset the repository deleting all events
   */
  reset: () => Promise<void>;
  /**
   * Mark an event as recorded by the server
   *
   * @param eventId the id of the event to mark as recorded
   * @param recordedAt the date-time the event was recorded at
   * @param recordedBy the id of the account that recorded the event
   */
  markRecorded: (eventId: string, recordedAt: Date, recordedBy: string) => Promise<void>;
  /**
   * Get all unrecorded events
   *
   * @returns promise of all unrecorded events
   */
  getUnrecorded: () => Promise<AnyAggregateEvent[]>;
  /**
   * Get the last recorded event
   *
   * @returns promise of the last recorded event
   */
  getLastRecordedEvent: () => Promise<AnyAggregateEvent | null>;
};

export type AccountInterface = { id: string };

export type AuthAdapter<U extends AccountInterface> = {
  /**
   * Get the id of the device
   *
   * @returns promise of the id of the device
   */
  getDeviceId: () => Promise<string>;
  /**
   * Get the account
   *
   * @returns promise of the account
   */
  getAccount: () => Promise<U | null>;
};

export type BaseState = {
  /** The id of the aggregate */
  id: string;
  /** The id of the account that created the aggregate */
  createdBy?: string;
  /** The id of the device that created the aggregate */
  createdOn: string;
  /** The id of the last event that was applied to the aggregate */
  lastEventId: string;
  /** The date-time the aggregate was created at */
  createdAt: Date;
  /** The date-time the aggregate was last updated at */
  updatedAt: Date;
  /** The version number of the aggregate */
  version: number;
};

export type AggregateRepository<S> = {
  /**
   * Get the state of the aggregate with the given id
   *
   * @param id the id of the aggregate
   * @returns promise of the state of the aggregate
   */
  getOne: (id: string) => Promise<S>;
  /**
   * Get states of all aggregates
   *
   * @returns promise of states of all aggregates keyed by id
   */
  getAll: () => Promise<{ [id: string]: S }>;
  /**
   * Insert a new aggregate with the given state and id
   *
   * @param id the id of the aggregate
   * @param state the state of the aggregate
   */
  insert: (id: string, state: S) => Promise<void>;
  /**
   * Update the state of the aggregate with the given id
   *
   * @param id the id of the aggregate
   * @param state the state of the aggregate
   */
  update: (id: string, state: S) => Promise<void>;
  /**
   * Delete the state of the aggregate with the given id
   *
   * @param id the id of the aggregate
   */
  delete: (id: string) => Promise<void>;
  /**
   * Delete all aggregates in the repository
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
  /** The type of the event */
  eventType: T;
  /** The operation the command performs */
  operation: O;
  /** The policy that determines if the account is authorized to execute the command */
  authPolicy: Policy<U, A, O, T, P>;
  /** The schema of the payload */
  payloadSchema?: ZodSchema<P>;
} & (O extends 'create'
  ? {
      /**
       * The function that constructs the initial state of the aggregate
       *
       * @param payload the payload of the event
       * @returns the initial state of the aggregate
       */
      construct: (payload: P) => Omit<S, keyof BaseState>;
      reduce?: undefined;
      destruct?: undefined;
    }
  : O extends 'update'
  ? {
      construct?: undefined;
      /**
       * The function that updates the state of the aggregate
       *
       * @param state the current state of the aggregate
       * @param payload the payload of the event
       * @returns the new state of the aggregate
       */
      reduce: (state: S, payload: P) => Omit<S, keyof BaseState>;
      destruct?: undefined;
    }
  : O extends 'delete'
  ? {
      construct?: undefined;
      reduce?: undefined;
      /**
       * A function to call before deleting the aggregate
       *
       * @param state the current state of the aggregate
       * @param payload the payload of the event
       */
      destruct?: (state: S, payload: P) => void;
    }
  : never);

export type AggregateConfig<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  C extends {
    [fn: string]: AggregateCommandConfig<U, A, Operation, string, S, any>;
  }
> = {
  /** The type of the aggregate */
  aggregateType: A;
  /** The schema of the aggregate state */
  aggregateSchema?: ZodSchema<Omit<S, keyof BaseState>>;
  /** The repository for persisting the aggregates state in */
  aggregateRepository?: AggregateRepository<S>;

  aggregateCommands: C;
  createId?: () => string;
};
