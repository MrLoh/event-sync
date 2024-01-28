import { UnauthenticatedError, UnauthorizedError } from '../utils/errors';
import type {
  AccountInterface,
  AggregateCommandsMaker,
  AggregateConfig,
  AggregateEventConfig,
  AnyAggregateEvent,
  AnyRecordedAggregateEvent,
  AuthAdapter,
  BaseState,
  EventsRepository,
  Operation,
} from '../utils/types';
import type { EventBus } from './event-bus';
import { createStore, type AggregateStore, AnyAggregateStore } from './store';

export type Server<U extends AccountInterface> = {
  /**
   * Register an aggregate config with the broker
   *
   * @param agg the aggregate config to register
   * @returns an aggregate store object
   */
  register: <
    A extends string,
    S extends BaseState,
    E extends { [fn: string]: AggregateEventConfig<U, A, any, any, S, any> },
    C extends AggregateCommandsMaker<U, A, S, E>
  >(
    agg: AggregateConfig<U, A, S, E, C> | { config: AggregateConfig<U, A, S, E, C> }
  ) => AggregateStore<U, A, S, E, C>;
  /**
   * Record an event to the central repository
   *
   * @param event the event to record
   * @returns promise of the recorded event with updated metadata
   */
  recordEvent: (event: AnyAggregateEvent) => Promise<AnyRecordedAggregateEvent>;
  /**
   * Get all new events since lastReceivedEventId
   *
   * @param lastReceivedEventId - last event id received or null if this is the first fetch
   * @returns promise with array of the new events
   */
  getEvents: (lastReceivedEventId: string | null) => Promise<AnyAggregateEvent[]>;
  /**
   * Subscribe to any new events recorded from other devices
   *
   * @remarks
   * This is only available if an event bus is provided to the server
   *
   * @param lastReceivedEventId the last event id received by the subscriber
   * @param subscriber function to call when a new event is received
   * @returns function to unsubscribe from new events
   */
  subscribeToEvents?: (
    lastReceivedEventId: string,
    subscriber: (event: AnyAggregateEvent) => void
  ) => () => void;
};

export const createServer = <U extends AccountInterface>({
  authAdapter,
  eventBus,
  eventsRepository,
  createEventId,
}: {
  /** The auth adapter to get device ids and accounts */
  authAdapter: AuthAdapter<U>;
  /** The event bus to enable subscribing to changes on other backend workers */
  eventBus?: EventBus;
  /** The repository for persisting events*/
  eventsRepository: EventsRepository;
  /** The id generator */
  createEventId: () => string;
}): Server<U> => {
  const stores: { [aggregateType: string]: AnyAggregateStore<U> } = {};
  const register = <
    A extends string,
    S extends BaseState,
    E extends { [fn: string]: AggregateEventConfig<U, A, Operation, string, S, any> },
    C extends AggregateCommandsMaker<U, A, S, E>
  >(
    agg: AggregateConfig<U, A, S, E, C> | { config: AggregateConfig<U, A, S, E, C> }
  ) => {
    const store = createStore(agg, {
      createEventId,
      authAdapter,
      eventBus,
      eventsRepository,
    });
    const aggregateType = 'config' in agg ? agg.config.aggregateType : agg.aggregateType;
    stores[aggregateType] = store;
    return store;
  };

  const recordEvent = async (event: AnyAggregateEvent) => {
    const account = await authAdapter.getAccount();
    if (!account) throw new UnauthenticatedError();
    if (account.id !== event.createdBy) throw new UnauthorizedError('Account mismatch');
    const recordedEvent = { ...event, recordedAt: new Date(), createdBy: account.id };
    await stores[event.aggregateType]!.applyEvent(recordedEvent);
    return recordedEvent;
  };

  const getEvents = async (lastReceivedEventId: string | null) => {
    const account = await authAdapter.getAccount();
    if (!account) throw new UnauthenticatedError();
    const events = await eventsRepository!.getNewSince(lastReceivedEventId);
    return events.filter((event) => {
      // TODO: filter out events that the account doesn't have access to
      stores[event.aggregateType]!;
    });
  };

  return {
    register,
    recordEvent,
    getEvents,
  };
};
