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
    expect(await profilesRepository.getOne('p1')).toEqual(
      expect.objectContaining({ name: 'tester', version: 1 })
    );
  });

  it('should generate aggregate config with commands', () => {
    // Given a payload schema
    const profileSchema = z.object({ name: z.string().min(2) });
    // And a constructor function
    const constructor = (payload: { name: string }) => payload;
    // When a new config is constructed with commands
    const { config } = ctx
      .aggregate('PROFILE')
      .schema(profileSchema)
      .commands((command) => ({
        create: command('CREATED', 'create').payload(profileSchema).constructor(constructor),
      }));
    // Then the config should have the correct commands
    expect(Object.keys(config.aggregateCommands ?? {})).toEqual(['create']);
    expect(config.aggregateCommands.create).toEqual(
      expect.objectContaining({
        eventType: 'CREATED',
        operation: 'create',
        payloadSchema: profileSchema,
        construct: constructor,
      })
    );
  });

  it('should throw error if command action is not defined', () => {
    // Given a base aggregate config definition
    const baseConfig = () => ctx.aggregate('PROFILE').schema(z.object({ name: z.string().min(2) }));
    // When trying to define a create command without a constructor
    expect(
      () => baseConfig().commands((command) => ({ create: command('CREATED', 'create') }))
      // Then an error should be thrown
    ).toThrowError('missing constructor definition');
    // When trying to define an update command without a reducer
    expect(
      () => baseConfig().commands((command) => ({ create: command('UPDATED', 'update') }))
      // Then an error should be thrown
    ).toThrowError('missing reducer definition');
    // When trying to define a delete command without a destructor
    expect(
      () => baseConfig().commands((command) => ({ create: command('DELETED', 'delete') }))
      // Then no error should be thrown
    ).not.toThrowError('missing destructor definition');
  });

  it('can define specific policy for command', () => {
    // Given an aggregate with a default policy
    const base = ctx
      .aggregate('PROFILE', { defaultPolicy: () => false })
      .schema(z.object({ name: z.string().min(2) }));
    // When defining a command with a policy
    const commandPolicy = jest.fn(() => true);
    const { config } = base.commands((command) => ({
      update: command('UPDATED', 'update')
        .payload(z.object({ name: z.string().min(2) }))
        .policy(commandPolicy)
        .reducer((state, payload) => ({ ...state, ...payload })),
    }));
    // Then the command policy should be used
    expect(config.aggregateCommands.update.authPolicy).toBe(commandPolicy);
    config.aggregateCommands.update.authPolicy({ id: 'tester', roles: [] }, {} as any);
    expect(commandPolicy).toHaveBeenCalled();
  });

  it('can define default policy on aggregate', () => {
    // Given a default policy is defined on the aggregate
    const aggregatePolicy = jest.fn(() => true);
    const base = ctx
      .aggregate('PROFILE', { defaultPolicy: aggregatePolicy })
      .schema(z.object({ name: z.string().min(2) }));
    // When the command policy is not defined
    const { config } = base.commands((command) => ({
      delete: command('DELETED', 'delete')
        .payload(z.object({ name: z.string().min(2) }))
        .destructor(() => {}),
    }));
    // Then the aggregate policy should be used
    expect(config.aggregateCommands.delete.authPolicy).toBe(aggregatePolicy);
    config.aggregateCommands.delete.authPolicy({ id: 'tester', roles: [] }, {} as any);
  });

  it('can define default policy on context', () => {
    // Given a default policy is defined on the context
    const contextPolicy = jest.fn(() => true);
    const ctx = createAggregateContext<Account>({ createId, defaultPolicy: contextPolicy });
    // When the aggregate and command policy is not defined
    const { config } = ctx
      .aggregate('PROFILE')
      .schema(z.object({ name: z.string().min(2) }))
      .commands((command) => ({
        create: command('CREATED', 'create')
          .payload(z.object({ name: z.string().min(2) }))
          .constructor((state) => state),
      }));
    // Then the context policy should be used
    expect(config.aggregateCommands.create.authPolicy).toBe(contextPolicy);
    config.aggregateCommands.create.authPolicy({ id: 'tester', roles: [] }, {} as any);
    expect(contextPolicy).toHaveBeenCalled();
  });

  it('throw error if no policy is defined', () => {
    // Given no default policy is defined on the context or the aggregate
    const ctx = createAggregateContext<Account>({ createId });
    const base = ctx.aggregate('PROFILE').schema(z.object({ name: z.string().min(2) }));
    // When trying to define a command without a policy
    expect(
      () =>
        base.commands((command) => ({
          create: command('CREATED', 'create')
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

  it('can define default commands based on schema', () => {
    // Given a schema
    const profileSchema = z.object({ name: z.string().min(2) });
    // When a new config is constructed with a schema and the setDefaultCommands option
    const { config } = ctx
      .aggregate('PROFILE')
      .schema(profileSchema, { createDefaultCommands: true });
    // Then the config should have default commands defined
    expect(Object.keys(config.aggregateCommands ?? {})).toEqual(['create', 'update', 'delete']);
    expect(config.aggregateCommands.create).toEqual(
      expect.objectContaining({
        eventType: 'CREATED',
        operation: 'create',
        payloadSchema: profileSchema,
      })
    );
    expect(config.aggregateCommands.create.construct({ name: 'tester' })).toEqual({
      name: 'tester',
    });
    expect(config.aggregateCommands.update).toEqual(
      expect.objectContaining({ eventType: 'UPDATED', operation: 'update' })
    );
    expect(config.aggregateCommands.update.payloadSchema?.parse({})).toEqual({});
    expect(
      config.aggregateCommands.update.reduce(createAggregateObject({ id: 'p1', name: 'tester' }), {
        name: 'tester 2',
      })
    ).toEqual(expect.objectContaining({ name: 'tester 2' }));
    expect(config.aggregateCommands.delete).toEqual(
      expect.objectContaining({ eventType: 'DELETED', operation: 'delete' })
    );
    expect(config.aggregateCommands.delete.payloadSchema?.parse(undefined)).toBe(undefined);
  });

  it('throws error if trying to overwrite command definitions', () => {
    // Given commands are already defined via the schema
    const base1 = ctx
      .aggregate('PROFILE')
      .schema(z.object({ name: z.string().min(2) }), { createDefaultCommands: true });
    // When trying to define commands
    expect(
      () => base1.commands((command) => ({ delete: command('DELETED', 'delete') }))
      // Then an error should be thrown
    ).toThrowError('Commands already set');
    // Given commands are already defined via the commands function
    const base2 = ctx
      .aggregate('PROFILE')
      .commands((command) => ({ delete: command('DELETED', 'delete') }));
    // When trying to define commands via the schema
    expect(
      () => base2.schema(z.object({ name: z.string().min(2) }), { createDefaultCommands: true })
      // Then an error should be thrown
    ).toThrowError('Commands already set');
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
});
