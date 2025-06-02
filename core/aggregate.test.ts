import { z } from 'zod';

import {
  createAggregateObject,
  createEvent,
  createFakeAggregateRepository,
  createId,
  type Account,
} from '../utils/fakes';
import type { BaseState } from '../utils/types';
import { createContext } from './aggregate';

describe('create aggregate config', () => {
  const ctx = createContext<Account>({
    createEventId: createId,
    defaultEventDispatchPolicy: () => true,
  });

  it('should generate aggregate config with type', () => {
    // When a new config is constructed with a type
    const { config } = ctx.aggregate('profile');
    // Then the config should have the correct type
    expect(config.aggregateType).toBe('profile');
  });

  it('should generate aggregate config with schema', () => {
    // Given a schema
    const profileSchema = z.object({ name: z.string().min(2) });
    // When a new config is constructed with a schema
    const { config } = ctx.aggregate('profile').schema(profileSchema);
    // Then the config should have the correct schema
    expect(config.aggregateSchema).toBe(profileSchema);
  });

  it('throws error if trying to overwrite schema definition', () => {
    // Given a schema is already defined
    const base = ctx.aggregate('profile').schema(z.object({ name: z.string().min(2) }));
    // When trying to overwrite the schema
    expect(
      () => base.schema(z.object({ name: z.string().min(2) })),
      // Then an error should be thrown
    ).toThrow('Schema already set');
  });

  it('should generate aggregate config with repository', async () => {
    // Given a repository
    const profilesRepository = createFakeAggregateRepository<{ name: string } & BaseState>();
    // When a new config is constructed with a repository
    const { config } = ctx
      .aggregate('profile')
      .schema(z.object({ name: z.string().min(2) }))
      .repository(profilesRepository);
    // Then the config should have the correct repository
    expect(config.aggregateRepository).toBe(profilesRepository);
    config.aggregateRepository?.create(createAggregateObject({ id: 'p1', name: 'tester' }));
    expect(await profilesRepository.getOne('p1')).toMatchObject({ name: 'tester', version: 1 });
  });

  it('throws error if trying to overwrite repository definition', () => {
    // Given a repository is already defined
    const base = ctx.aggregate('profile').repository(createFakeAggregateRepository<BaseState>());
    // When trying to overwrite the repository
    expect(
      () => base.repository(createFakeAggregateRepository<BaseState>()),
      // Then an error should be thrown
    ).toThrow('Repository already set');
  });

  it('should generate aggregate config with events', () => {
    // Given a payload schema
    const profileSchema = z.object({ name: z.string().min(2) });
    // And a constructor function
    const constructor = (payload: { name: string }) => payload;
    // When a new config is constructed with events
    const { config } = ctx
      .aggregate('profile')
      .schema(profileSchema)
      .events((event) => ({
        create: event('create').payload(profileSchema).constructor(constructor),
      }));
    // Then the config should have the correct events
    expect(Object.keys(config.aggregateEvents ?? {})).toEqual(['create']);
    expect(config.aggregateEvents.create).toMatchObject({
      eventType: 'profile.create',
      operation: 'create',
      payloadSchema: profileSchema,
      construct: constructor,
    });
  });

  it('should generate aggregate config with event schema', () => {
    // Given a payload schema
    const profileSchema = z.object({ name: z.string().min(2) });
    // And a config with a create and update event
    const { config } = ctx
      .aggregate('profile')
      .schema(profileSchema)
      .events((event) => ({
        create: event('create')
          .payload(profileSchema)
          .constructor((payload) => payload),
        update: event('update')
          .payload(profileSchema.partial())
          .reducer((state, payload) => ({ ...state, ...payload })),
      }));
    // When the event schema is used with a valid create event
    const res1 = config.eventSchema!.safeParse(
      createEvent('profile', 'profile.create', { payload: { name: 'test' } }),
    );
    // Then the event should be valid
    expect(res1.success).toBe(true);
    // When the event schema is used with an invalid create event
    const res2 = config.eventSchema!.safeParse(
      createEvent('profile', 'profile.create', { payload: {} }),
    );
    // Then the event should be invalid
    expect(res2.success).toBe(false);
    // When the event schema is used with a valid update event
    const res3 = config.eventSchema!.safeParse(
      createEvent('profile', 'profile.update', { operation: 'update', payload: {}, prevId: 'p1' }),
    );
    // Then the event should be valid
    expect(res3.success).toBe(true);
    // When the event schema is used with an invalid update event
    const res4 = config.eventSchema!.safeParse(
      createEvent('profile', 'profile.update', { operation: 'update', payload: {}, prevId: '' }),
    );
    // Then the event should be invalid
    expect(res4.success).toBe(false);
  });

  it('should throw error if event action is not defined', () => {
    // Given a base aggregate config definition
    const baseConfig = () => ctx.aggregate('profile').schema(z.object({ name: z.string().min(2) }));
    // When trying to define a create event without a constructor
    expect(
      () => baseConfig().events((event) => ({ create: event('create') })),
      // Then an error should be thrown
    ).toThrow('missing constructor definition');
    // When trying to define an update event without a reducer
    expect(
      () => baseConfig().events((event) => ({ update: event('update') })),
      // Then an error should be thrown
    ).toThrow('missing reducer definition');
    // When trying to define a delete event without a destructor
    expect(
      () => baseConfig().events((event) => ({ delete: event('delete') })),
      // Then no error should be thrown
    ).not.toThrow('missing destructor definition');
  });

  it('can overwrite default event type', () => {
    // Given a base aggregate config definition
    const baseConfig = () => ctx.aggregate('profile').schema(z.object({ name: z.string().min(2) }));
    // When defining a create event with a custom event type
    const { config } = baseConfig().events((event) => ({
      create: event('create')
        .type('profile.created')
        .payload(z.object({ name: z.string().min(2) }))
        .constructor((state) => state),
    }));
    // Then the event type should be set correctly
    expect(config.aggregateEvents.create.eventType).toBe('profile.created');
  });

  it('can define specific dispatch policy for event', () => {
    // Given an aggregate with a default policy
    const base = ctx
      .aggregate('profile', { defaultEventDispatchPolicy: () => false })
      .schema(z.object({ name: z.string().min(2) }));
    // When defining a event with a policy
    const eventDispatchPolicy = jest.fn(() => true);
    const { config } = base.events((event) => ({
      update: event('update')
        .payload(z.object({ name: z.string().min(2) }))
        .policy(eventDispatchPolicy)
        .reducer((state, payload) => ({ ...state, ...payload })),
    }));
    // Then the event policy should be used
    expect(config.aggregateEvents.update.dispatchPolicy).toBe(eventDispatchPolicy);
    config.aggregateEvents.update.dispatchPolicy({ id: 'tester', roles: [] }, {} as any, {} as any);
    expect(eventDispatchPolicy).toHaveBeenCalled();
  });

  it('can define default dispatch policy on aggregate', () => {
    // Given a default policy is defined on the aggregate
    const aggregatePolicy = jest.fn(() => true);
    const base = ctx
      .aggregate('profile', { defaultEventDispatchPolicy: aggregatePolicy })
      .schema(z.object({ name: z.string().min(2) }));
    // When the event policy is not defined
    const { config } = base.events((event) => ({
      delete: event('delete')
        .payload(z.object({ name: z.string().min(2) }))
        .destructor(() => {}),
    }));
    // Then the aggregate policy should be used
    expect(config.aggregateEvents.delete.dispatchPolicy).toBe(aggregatePolicy);
    config.aggregateEvents.delete.dispatchPolicy({ id: 'tester', roles: [] }, {} as any, {} as any);
    // And the default policy should be set on the config
    expect(config.defaultEventDispatchPolicy).toBe(aggregatePolicy);
  });

  it('can define default dispatch policy on context', () => {
    // Given a default policy is defined on the context
    const contextPolicy = jest.fn(() => true);
    const ctx = createContext<Account>({
      createEventId: createId,
      defaultEventDispatchPolicy: contextPolicy,
    });
    // When the aggregate and event policy is not defined
    const { config } = ctx
      .aggregate('profile')
      .schema(z.object({ name: z.string().min(2) }))
      .events((event) => ({
        create: event('create')
          .payload(z.object({ name: z.string().min(2) }))
          .constructor((state) => state),
      }));
    // Then the context policy should be used
    expect(config.aggregateEvents.create.dispatchPolicy).toBe(contextPolicy);
    config.aggregateEvents.create.dispatchPolicy({ id: 'tester', roles: [] }, {} as any, {} as any);
    expect(contextPolicy).toHaveBeenCalled();
    // And the default policy should be set on the config
    expect(config.defaultEventDispatchPolicy).toBe(contextPolicy);
  });

  it('throw error if no policy is defined', () => {
    // Given no default policy is defined on the context or the aggregate
    const ctx = createContext<Account>();
    const base = ctx.aggregate('profile').schema(z.object({ name: z.string().min(2) }));
    // When trying to define a event without a policy
    expect(
      () =>
        base.events((event) => ({
          create: event('create')
            .payload(z.object({ name: z.string().min(2) }))
            .constructor((state) => state),
        })),
      // Then an error should be thrown
    ).toThrow('missing dispatch policy definition for create event');
  });

  it('can define default read policy on context', () => {
    // Given a default read policy is defined on the context
    const contextPolicy = jest.fn(() => true);
    const ctx = createContext<Account>({
      createEventId: createId,
      defaultAggregateReadPolicy: contextPolicy,
    });
    // When the aggregate is defined without a read policy
    const { config } = ctx.aggregate('profile').schema(z.object({ name: z.string().min(2) }));
    // Then the context policy should be used
    expect(config.aggregateReadPolicy).toBe(contextPolicy);
    config.aggregateReadPolicy({ id: 'tester', roles: [] }, {} as any);
    expect(contextPolicy).toHaveBeenCalled();
  });

  it('can define default read policy on aggregate', () => {
    // Given a read policy is defined on the aggregate
    const aggregatePolicy = jest.fn(() => true);
    const { config } = ctx
      .aggregate('profile', { aggregateReadPolicy: aggregatePolicy })
      .schema(z.object({ name: z.string().min(2) }));
    // Then the aggregate policy should be used
    expect(config.aggregateReadPolicy).toBe(aggregatePolicy);
    config.aggregateReadPolicy({ id: 'tester', roles: [] }, {} as any);
    expect(aggregatePolicy).toHaveBeenCalled();
  });

  it('throw error if no read policy is defined', () => {
    // Given no default read policy is defined on the context or the aggregate
    const ctx = createContext<Account>();
    const base = ctx.aggregate('profile').schema(z.object({ name: z.string().min(2) }));
    // When trying to define a event without a policy
    expect(
      () => base.events((event) => ({ create: event('create') })),
      // Then an error should be thrown
    ).toThrow('missing dispatch policy definition for create event');
  });

  it('can define create id on context', () => {
    // Given a create id function is defined on the context
    const createId = jest.fn(() => 'test');
    const ctx = createContext<Account>({ createEventId: createId });
    // When the aggregate is defined without a create id function
    const { config } = ctx.aggregate('profile').schema(z.object({ name: z.string().min(2) }));
    // Then the context create id function should be used
    expect(config.createAggregateId).toBe(createId);
    config.createAggregateId?.();
    expect(createId).toHaveBeenCalled();
  });

  it('can define create id on aggregate', () => {
    // Given a create id function is defined on the aggregate
    const createId = jest.fn(() => 'test');
    const { config } = ctx
      .aggregate('profile', { createAggregateId: createId })
      .schema(z.object({ name: z.string().min(2) }));
    // Then the aggregate create id function should be used
    expect(config.createAggregateId).toBe(createId);
    config.createAggregateId?.();
    expect(createId).toHaveBeenCalled();
  });

  it('can define default events based on schema', () => {
    // Given a schema
    const profileSchema = z.object({ name: z.string().min(2) });
    // When a new config is constructed with a schema and the setDefaultEvents option
    const { config } = ctx
      .aggregate('profile')
      .schema(profileSchema, { createDefaultEvents: true });
    // Then the config should have default events defined
    expect(Object.keys(config.aggregateEvents ?? {})).toEqual(['create', 'update', 'delete']);
    expect(config.aggregateEvents.create).toMatchObject({
      eventType: 'profile.create',
      operation: 'create',
      payloadSchema: profileSchema,
    });
    expect(config.aggregateEvents.create.construct({ name: 'tester' })).toEqual({
      name: 'tester',
    });
    expect(config.aggregateEvents.update).toMatchObject({
      eventType: 'profile.update',
      operation: 'update',
    });
    expect(config.aggregateEvents.update.payloadSchema?.parse({})).toEqual({});
    expect(
      config.aggregateEvents.update.reduce(createAggregateObject({ id: 'p1', name: 'tester' }), {
        name: 'tester 2',
      }),
    ).toMatchObject({ name: 'tester 2' });
    expect(config.aggregateEvents.delete).toMatchObject({
      eventType: 'profile.delete',
      operation: 'delete',
    });
    expect(config.aggregateEvents.delete.payloadSchema?.parse(undefined)).toBe(undefined);
  });

  it('throws error if trying to overwrite event definitions', () => {
    // Given events are already defined via the schema
    const base1 = ctx
      .aggregate('profile')
      .schema(z.object({ name: z.string().min(2) }), { createDefaultEvents: true });
    // When trying to define events
    expect(
      () => base1.events((event) => ({ delete: event('delete') })),
      // Then an error should be thrown
    ).toThrow('Events already set');
    // Given events are already defined via the events function
    const base2 = ctx.aggregate('profile').events((event) => ({ delete: event('delete') }));
    // When trying to define events via the schema
    expect(
      () => base2.schema(z.object({ name: z.string().min(2) }), { createDefaultEvents: true }),
      // Then an error should be thrown
    ).toThrow('Events already set');
  });

  it('can define commands', () => {
    // Given a command maker function
    const commandMaker = jest.fn(() => ({
      command: () => {},
    }));
    // When a new config is constructed with a command
    const { config } = ctx
      .aggregate('profile')
      .schema(z.object({ name: z.string().min(2) }))
      .events((event) => ({
        create: event('create')
          .payload(z.object({ name: z.string().min(2) }))
          .constructor((state) => state),
      }))
      .commands(commandMaker);
    // Then the config should have the correct command maker
    expect(config.aggregateCommandMaker).toBe(commandMaker);
  });

  it('throws error if trying to overwrite command maker definition', () => {
    // Given a command maker is already defined
    const base = ctx.aggregate('profile').commands(() => ({}));
    // When trying to overwrite the command maker
    expect(
      () => base.commands(() => ({})),
      // Then an error should be thrown
    ).toThrow('Commands already set');
  });

  it('can pass register function to aggregate config', () => {
    // Given a register function
    const register = jest.fn();
    // When a new config is constructed with a register function
    const base = ctx.aggregate('profile', { register });
    // And the register function is called on the builder
    base.register();
    // Then the register function should be called with the config
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ aggregateType: 'profile' }));
  });
});
