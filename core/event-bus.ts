import { ReplaySubject, Subject, startWith, switchMap } from 'rxjs';
import type { AnyAggregateEvent } from '../utils/types';

export type EventBus<E extends AnyAggregateEvent = AnyAggregateEvent> = {
  /**
   * will call the subscriber with previously dispatched events and for all future events
   *
   * @param subscriber the function to call when an event is dispatched
   * @returns a function to unsubscribe
   */
  subscribe: (subscriber: (event: E) => void) => () => void;
  /**
   * dispatch an event to the event bus
   *
   * @param event the event to dispatch
   */
  dispatch: (event: E) => void;
  /**
   * terminate the subject underlying the event bus with an error
   *
   * @param error the terminal error that occurred
   */
  error: (error: Error) => void;
  /**
   * reset the event bus preventing any past events to be replayed to subscribers
   */
  reset: () => void;
};

/**
 * create an event bus for aggregate events
 *
 * @returns an event bus
 */
export const createEventBus = <E extends AnyAggregateEvent = AnyAggregateEvent>(): EventBus<E> => {
  const resetter = new Subject<null>();
  const source = new Subject<E>();
  let destination = new ReplaySubject<E>();
  let subscription = source.subscribe(destination);
  return {
    dispatch: (event: E) => {
      source.next(event);
    },
    error: (error: Error) => {
      source.error(error);
    },
    subscribe: (subscriber: (event: E) => void) => {
      const subscription = resetter
        .asObservable()
        .pipe(
          startWith(null),
          switchMap(() => destination)
        )
        .subscribe({
          next: (event) => subscriber(event),
          error: (error) => {
            throw error;
          },
        });
      return subscription.unsubscribe;
    },
    reset: () => {
      subscription.unsubscribe();
      destination = new ReplaySubject<E>();
      subscription = source.subscribe(destination);
      resetter.next(null);
    },
  };
};
