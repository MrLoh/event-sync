import { ReplaySubject, Subject, startWith, switchMap } from 'rxjs';
import type { AnyAggregateEvent } from '../utils/types';

export type EventBus<E extends AnyAggregateEvent = AnyAggregateEvent> = {
  /**
   * dispatch an event to the event bus
   *
   * @param event the event to dispatch
   */
  dispatch: (event: E) => void;

  /**
   * will call the subscriber with previously dispatched events and for all future events
   *
   * @param subscriber the function to call when an event is dispatched
   * @returns a function to unsubscribe
   */
  subscribe: (subscriber: (event: E) => void) => () => void;
  /**
   * setup an error handler for when the event bus is terminated with an error. If no error handler
   * is registered, the error will be thrown in the global scope.
   *
   * @param callback the function to call when an error occurs
   */
  terminate: (error?: Error) => void;
  /**
   * terminate the event bus because an error occurred or because the event bus is no longer needed
   *
   * @param error the terminal error that occurred
   */
  onTermination(callback: (error?: Error) => void): void;
  /**
   * whether the event bus has been terminated
   */
  terminated: boolean;
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
  const resetter$ = new Subject<null>();
  let source$ = new Subject<E>();
  let destination$ = new ReplaySubject<E>();
  let subscription = source$.subscribe(destination$);
  const emitter$ = resetter$.asObservable().pipe(
    startWith(null),
    switchMap(() => destination$)
  );
  let terminated = false;
  // if no error handler is provided, throw error if terminated with error
  const defaultErrorSubscription = emitter$.subscribe({
    error: (error: Error) => {
      // istanbul ignore next -- cannot test global errors
      throw error;
    },
  });
  return {
    dispatch: (event: E) => {
      if (terminated) throw new Error('cannot dispatch, event bus has been terminated');
      source$.next(event);
    },
    terminate: (error?: Error) => {
      terminated = true;
      if (error) source$.error(error);
      else source$.complete();
    },
    subscribe: (subscriber: (event: E) => void) => {
      const subscription = emitter$.subscribe({ next: subscriber, error: () => {} });
      return () => subscription.unsubscribe();
    },
    onTermination: (callback: (error?: Error) => void) => {
      defaultErrorSubscription.unsubscribe();
      emitter$.subscribe({ error: callback, complete: callback });
    },
    get terminated() {
      return terminated;
    },
    reset: () => {
      if (terminated) {
        source$ = new Subject<E>();
        terminated = false;
      }
      subscription.unsubscribe();
      destination$ = new ReplaySubject<E>();
      subscription = source$.subscribe(destination$);
      resetter$.next(null);
    },
  };
};
