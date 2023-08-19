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
