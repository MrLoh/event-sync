import { z } from 'zod';

import { createAggregateContext } from './aggregate';
import {
  createId,
  type Account,
  createFakeAggregateRepository,
  createAggregateObject,
} from '../utils/fakes';
import type { BaseState } from '../utils/types';

describe('create aggregate config', () => {
  const ctx = createAggregateContext<Account>({ createId, defaultPolicy: () => true });

  it('should generate aggregate config with type', () => {
    // When a new config is constructed with a type
    const { config } = ctx.aggregate('PROFILE');
    // Then the config should have the correct type
    expect(config.aggregateType).toBe('PROFILE');
  });

  it('should generate aggregate config with schema', () => {
    // Given a schema
    const profileSchema = z.object({ name: z.string().min(2) });
    // When a new config is constructed with a schema
    const { config } = ctx.aggregate('PROFILE').schema(profileSchema);
    // Then the config should have the correct schema
    expect(config.aggregateSchema).toBe(profileSchema);
  });

  it('should generate aggregate config with repository', async () => {
    // Given a repository
    const profilesRepository = createFakeAggregateRepository<{ name: string } & BaseState>();
    // When a new config is constructed with a repository
    const { config } = ctx
      .aggregate('PROFILE')
      .schema(z.object({ name: z.string().min(2) }))
      .repository(profilesRepository);
    // Then the config should have the correct repository
    expect(config.aggregateRepository).toBe(profilesRepository);
    config.aggregateRepository?.insert('p1', createAggregateObject({ id: 'p1', name: 'tester' }));
    expect(await profilesRepository.getOne('p1')).toMatchObject({ name: 'tester', version: 1 });
  });

  it('should generate aggregate config with events', () => {
    // Given a payload schema
    const profileSchema = z.object({ name: z.string().min(2) });
    // And a constructor function
    const constructor = (payload: { name: string }) => payload;
    // When a new config is constructed with events
    const { config } = ctx
      .aggregate('PROFILE')
      .schema(profileSchema)
      .events((event) => ({
        create: event('CREATED', 'create').payload(profileSchema).constructor(constructor),
      }));
    // Then the config should have the correct events
    expect(Object.keys(config.aggregateEvents ?? {})).toEqual(['create']);
    expect(config.aggregateEvents.create).toMatchObject({
      eventType: 'CREATED',
      operation: 'create',
      payloadSchema: profileSchema,
      construct: constructor,
    });
  });

  it('should throw error if event action is not defined', () => {
    // Given a base aggregate config definition
    const baseConfig = () => ctx.aggregate('PROFILE').schema(z.object({ name: z.string().min(2) }));
    // When trying to define a create event without a constructor
    expect(
      () => baseConfig().events((event) => ({ create: event('CREATED', 'create') }))
      // Then an error should be thrown
    ).toThrowError('missing constructor definition');
    // When trying to define an update event without a reducer
    expect(
      () => baseConfig().events((event) => ({ create: event('UPDATED', 'update') }))
      // Then an error should be thrown
    ).toThrowError('missing reducer definition');
    // When trying to define a delete event without a destructor
    expect(
      () => baseConfig().events((event) => ({ create: event('DELETED', 'delete') }))
      // Then no error should be thrown
    ).not.toThrowError('missing destructor definition');
  });

  it('can define specific policy for event', () => {
    // Given an aggregate with a default policy
    const base = ctx
      .aggregate('PROFILE', { defaultPolicy: () => false })
      .schema(z.object({ name: z.string().min(2) }));
    // When defining a event with a policy
    const eventPolicy = jest.fn(() => true);
    const { config } = base.events((event) => ({
      update: event('UPDATED', 'update')
        .payload(z.object({ name: z.string().min(2) }))
        .policy(eventPolicy)
        .reducer((state, payload) => ({ ...state, ...payload })),
    }));
    // Then the event policy should be used
    expect(config.aggregateEvents.update.authPolicy).toBe(eventPolicy);
    config.aggregateEvents.update.authPolicy({ id: 'tester', roles: [] }, {} as any);
    expect(eventPolicy).toHaveBeenCalled();
  });

  it('can define default policy on aggregate', () => {
    // Given a default policy is defined on the aggregate
    const aggregatePolicy = jest.fn(() => true);
    const base = ctx
      .aggregate('PROFILE', { defaultPolicy: aggregatePolicy })
      .schema(z.object({ name: z.string().min(2) }));
    // When the event policy is not defined
    const { config } = base.events((event) => ({
      delete: event('DELETED', 'delete')
        .payload(z.object({ name: z.string().min(2) }))
        .destructor(() => {}),
    }));
    // Then the aggregate policy should be used
    expect(config.aggregateEvents.delete.authPolicy).toBe(aggregatePolicy);
    config.aggregateEvents.delete.authPolicy({ id: 'tester', roles: [] }, {} as any);
  });

  it('can define default policy on context', () => {
    // Given a default policy is defined on the context
    const contextPolicy = jest.fn(() => true);
    const ctx = createAggregateContext<Account>({ createId, defaultPolicy: contextPolicy });
    // When the aggregate and event policy is not defined
    const { config } = ctx
      .aggregate('PROFILE')
      .schema(z.object({ name: z.string().min(2) }))
      .events((event) => ({
        create: event('CREATED', 'create')
          .payload(z.object({ name: z.string().min(2) }))
          .constructor((state) => state),
      }));
    // Then the context policy should be used
    expect(config.aggregateEvents.create.authPolicy).toBe(contextPolicy);
    config.aggregateEvents.create.authPolicy({ id: 'tester', roles: [] }, {} as any);
    expect(contextPolicy).toHaveBeenCalled();
  });

  it('throw error if no policy is defined', () => {
    // Given no default policy is defined on the context or the aggregate
    const ctx = createAggregateContext<Account>({ createId });
    const base = ctx.aggregate('PROFILE').schema(z.object({ name: z.string().min(2) }));
    // When trying to define a event without a policy
    expect(
      () =>
        base.events((event) => ({
          create: event('CREATED', 'create')
            .payload(z.object({ name: z.string().min(2) }))
            .constructor((state) => state),
        }))
      // Then an error should be thrown
    ).toThrowError('missing policy definition');
  });

  it('can define create id on context', () => {
    // Given a create id function is defined on the context
    const createId = jest.fn(() => 'test');
    const ctx = createAggregateContext<Account>({ createId });
    // When the aggregate is defined without a create id function
    const { config } = ctx.aggregate('PROFILE').schema(z.object({ name: z.string().min(2) }));
    // Then the context create id function should be used
    expect(config.createId).toBe(createId);
    config.createId?.();
    expect(createId).toHaveBeenCalled();
  });

  it('can define create id on aggregate', () => {
    // Given a create id function is defined on the aggregate
    const createId = jest.fn(() => 'test');
    const { config } = ctx
      .aggregate('PROFILE', { createId })
      .schema(z.object({ name: z.string().min(2) }));
    // Then the aggregate create id function should be used
    expect(config.createId).toBe(createId);
    config.createId?.();
    expect(createId).toHaveBeenCalled();
  });

  it('can define default events based on schema', () => {
    // Given a schema
    const profileSchema = z.object({ name: z.string().min(2) });
    // When a new config is constructed with a schema and the setDefaultEvents option
    const { config } = ctx
      .aggregate('PROFILE')
      .schema(profileSchema, { createDefaultEvents: true });
    // Then the config should have default events defined
    expect(Object.keys(config.aggregateEvents ?? {})).toEqual(['create', 'update', 'delete']);
    expect(config.aggregateEvents.create).toMatchObject({
      eventType: 'CREATED',
      operation: 'create',
      payloadSchema: profileSchema,
    });
    expect(config.aggregateEvents.create.construct({ name: 'tester' })).toEqual({
      name: 'tester',
    });
    expect(config.aggregateEvents.update).toMatchObject({
      eventType: 'UPDATED',
      operation: 'update',
    });
    expect(config.aggregateEvents.update.payloadSchema?.parse({})).toEqual({});
    expect(
      config.aggregateEvents.update.reduce(createAggregateObject({ id: 'p1', name: 'tester' }), {
        name: 'tester 2',
      })
    ).toMatchObject({ name: 'tester 2' });
    expect(config.aggregateEvents.delete).toMatchObject({
      eventType: 'DELETED',
      operation: 'delete',
    });
    expect(config.aggregateEvents.delete.payloadSchema?.parse(undefined)).toBe(undefined);
  });

  it('throws error if trying to overwrite event definitions', () => {
    // Given events are already defined via the schema
    const base1 = ctx
      .aggregate('PROFILE')
      .schema(z.object({ name: z.string().min(2) }), { createDefaultEvents: true });
    // When trying to define events
    expect(
      () => base1.events((event) => ({ delete: event('DELETED', 'delete') }))
      // Then an error should be thrown
    ).toThrowError('Events already set');
    // Given events are already defined via the events function
    const base2 = ctx
      .aggregate('PROFILE')
      .events((event) => ({ delete: event('DELETED', 'delete') }));
    // When trying to define events via the schema
    expect(
      () => base2.schema(z.object({ name: z.string().min(2) }), { createDefaultEvents: true })
      // Then an error should be thrown
    ).toThrowError('Events already set');
  });

  it('throws error if trying to overwrite schema definition', () => {
    // Given a schema is already defined
    const base = ctx.aggregate('PROFILE').schema(z.object({ name: z.string().min(2) }));
    // When trying to overwrite the schema
    expect(
      () => base.schema(z.object({ name: z.string().min(2) }))
      // Then an error should be thrown
    ).toThrowError('Schema already set');
  });

  it('throws error if trying to overwrite repository definition', () => {
    // Given a repository is already defined
    const base = ctx.aggregate('PROFILE').repository(createFakeAggregateRepository<BaseState>());
    // When trying to overwrite the repository
    expect(
      () => base.repository(createFakeAggregateRepository<BaseState>())
      // Then an error should be thrown
    ).toThrowError('Repository already set');
  });

  it('can pass register function to aggregate config', () => {
    // Given a register function
    const register = jest.fn();
    // When a new config is constructed with a register function
    const base = ctx.aggregate('PROFILE', { register });
    // And the register function is called on the builder
    base.register();
    // Then the register function should be called with the config
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ aggregateType: 'PROFILE' }));
  });
});
