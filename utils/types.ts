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
  createdOn: string;
  /** The id of the previous event */
  prevId: O extends 'create' ? undefined : string;
  /** The date-time the event was recorded at on the server */
  recordedAt?: Date;
};

export type AnyAggregateEvent = AggregateEvent<string, Operation, string, any>;

export type AnyRecordedAggregateEvent = AnyAggregateEvent & { recordedAt: Date; createdBy: string };

export type EventsRepository = {
  /**
   * Create a new event in the repository
   *
   * @param event the event to create
   */
  create: (event: AnyAggregateEvent) => Promise<void>;
  /**
   * Delete all events from the repository
   */
  deleteAll: () => Promise<void>;
  /**
   * Mark an event as recorded by the server
   *
   * @remarks
   * In case the event was created by an anonymous account, this will set the `createdBy` to the
   * account id of the account that recorded the event, since an event is only recorded if the
   * account is logged in. The created by will only be overwritten if it was previously undefined.
   *
   * @param eventId the id of the event to mark as recorded
   * @param update object containing when the event was recorded and what the created by should be
   */
  markRecorded: (eventId: string, update: { recordedAt: Date; createdBy: string }) => Promise<void>;
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
  getLastReceivedEvent: () => Promise<AnyAggregateEvent | null>;
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
  /** The date-time the last event for the aggregate was recorded at on the server */
  lastRecordedAt?: Date;
};

export type AggregateRepository<S extends BaseState> = {
  /**
   * Get the state of the aggregate with the given id
   *
   * @param id the id of the aggregate
   * @returns promise of the state of the aggregate
   */
  getOne: (id: string) => Promise<S | null>;
  /**
   * Get states of all aggregates
   *
   * @returns promise of states of all aggregates keyed by id
   */
  getAll: () => Promise<{ [id: string]: S }>;
  /**
   * Create a new aggregate with the given state and id
   *
   * @param state the state of the aggregate
   */
  create: (state: S) => Promise<void>;
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

export type EventDispatchPolicy<U extends AccountInterface, S extends BaseState, P> = (
  account: U | null,
  aggregate: S | null,
  event: AggregateEvent<string, Operation, string, P>
) => boolean;

export type AggregateEventConfig<
  U extends AccountInterface,
  A extends string,
  O extends Operation,
  T extends string,
  S extends BaseState,
  P
> = {
  /** The type of the aggregate */
  aggregateType: A;
  /** The type of the event */
  eventType: T;
  /** The operation the command performs */
  operation: O;
  /** The policy that determines if the account is authorized for the event */
  dispatchPolicy: EventDispatchPolicy<U, S, P>;
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

export type DefaultAggregateEventsConfig<
  U extends AccountInterface,
  A extends string,
  S extends BaseState
> = {
  create: AggregateEventConfig<U, A, 'create', `${A}.create`, S, Omit<S, keyof BaseState>>;
  update: AggregateEventConfig<U, A, 'update', `${A}.update`, S, Partial<Omit<S, keyof BaseState>>>;
  delete: AggregateEventConfig<U, A, 'delete', `${A}.delete`, S, undefined>;
};

export type AggregateEventDispatchers<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  E extends { [fn: string]: AggregateEventConfig<U, A, Operation, string, S, any> }
> = {
  [K in keyof E]: E[K] extends AggregateEventConfig<U, A, infer O, any, S, infer P>
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

export type AggregateCommandsContext<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  E extends { [fn: string]: AggregateEventConfig<U, A, Operation, string, S, any> }
> = AuthAdapter<U> & {
  /** Get the current state of the aggregate */
  getState: () => { [id: string]: S };
  /** A map of event dispatchers for the */
  events: AggregateEventDispatchers<U, A, S, E>;
};

export type AggregateCommandsMaker<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  E extends { [fn: string]: AggregateEventConfig<U, A, Operation, string, S, any> }
> = (context: AggregateCommandsContext<U, A, S, E>) => { [fn: string]: (...args: any[]) => any };

export type AggregateConfig<
  U extends AccountInterface,
  A extends string,
  S extends BaseState,
  E extends { [fn: string]: AggregateEventConfig<U, A, Operation, string, S, any> },
  C extends AggregateCommandsMaker<U, A, S, E>
> = {
  /** The type of the aggregate */
  aggregateType: A;
  /** The schema of the aggregate state */
  aggregateSchema?: ZodSchema<Omit<S, keyof BaseState>>;
  /** The repository for persisting the aggregates state in */
  aggregateRepository?: AggregateRepository<S>;
  /** The configuration for aggregate events */
  aggregateEvents: E;
  /** Factory for additional command functions that can be called on the aggregate */
  aggregateCommandMaker?: C;
  /** Function to generate unique IDs */
  createAggregateId?: () => string;
  /** The default policy for all actions that determines if the account is authorized for the event */
  defaultEventDispatchPolicy?: EventDispatchPolicy<U, S, any>;
  /** The schema of the aggregate events */
  eventSchema?: ZodSchema<
    {
      [F in keyof E]: E[F] extends AggregateEventConfig<U, infer A, infer O, infer T, S, infer P>
        ? AggregateEvent<A, O, T, P>
        : never;
    }[keyof E]
  >;
};

export type EventServerAdapter = {
  /**
   * Send an event to the server to be recorded
   *
   * @param event the event to record
   * @returns promise of the recorded event with updated metadata
   */
  record: (event: AnyAggregateEvent) => Promise<AnyRecordedAggregateEvent>;
  /**
   * Fetch new events since lastReceivedEventId from the server
   *
   * @param lastReceivedEventId
   * @returns promise with array of the new events
   */
  fetch: (lastReceivedEventId: string | null) => Promise<AnyAggregateEvent[]>;
  /**
   * Subscribe to new events from the server
   *
   * @param subscriber function to call when a new event is received
   * @returns function to unsubscribe from new events
   */
  subscribe?: (subscriber: (event: AnyAggregateEvent) => void) => () => void;
};

export type ConnectionStatusAdapter = {
  /**
   * Subscribe to connection status changes
   *
   * @param subscriber function to call when the connection status changes
   * @returns function to unsubscribe from connection status changes
   */
  subscribe: (subscriber: (connected: boolean | null) => void) => void;
  /**
   * Get the current connection status
   *
   * @returns promise of the current connection status
   */
  get: () => Promise<boolean | null>;
};
