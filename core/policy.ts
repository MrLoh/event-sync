import { AccountInterface, BaseState, Operation } from '../utils/types';

type PolicyCondition<S extends { [key: string]: unknown }> = Partial<{
  [K in keyof S]:
    | S[K]
    | { [op in 'lt' | 'gt' | 'lte' | 'gte']?: S[K] }
    | { in: S[K][] }
    | (S[K] extends string
        ? { startsWith?: S[K] } | { endsWith?: S[K] }
        : S[K] extends any[]
        ? { contains?: S[K] }
        : never);
}>;

type ComparisonOperator =
  | 'lt'
  | 'gt'
  | 'lte'
  | 'gte'
  | 'in'
  | 'startsWith'
  | 'endsWith'
  | 'contains';

type PolicyRule<S extends { [key: string]: unknown }> = {
  operation: Operation | 'read';
  /** an object of conditions which restricts the rule scope */
  conditions: PolicyCondition<S> | boolean;
  /** indicates whether rule allows or forbids something */
  inverted?: boolean;
  /** message which explains why rule is forbidden */
  reason?: string;
};

type PolicyBuilder<S extends { [key: string]: unknown }> = {
  rules: PolicyRule<S>[];
  allow: (conditions?: PolicyCondition<S> | boolean, reason?: string) => PolicyBuilder<S>;
  forbid: (conditions?: PolicyCondition<S> | boolean, reason?: string) => PolicyBuilder<S>;
};

const createPolicy = <U extends AccountInterface, S extends { [key: string]: unknown }>(
  make: (
    access: (operation: Operation | 'read') => PolicyBuilder<S>,
    account: U,
  ) => { rules: PolicyRule<S>[] },
) => {
  return (account: U) => {
    const makeBuilder = (operation: Operation | 'read') => {
      const builder: PolicyBuilder<S> = {
        rules: [],
        allow: (conditions, reason) => {
          builder.rules.push({
            operation,
            conditions: conditions ?? true,
            inverted: false,
            reason,
          });
          return builder;
        },
        forbid: (conditions, reason) => {
          builder.rules.push({
            operation,
            conditions: conditions ?? true,
            inverted: true,
            reason,
          });
          return builder;
        },
      };
      return builder;
    };
    return make(makeBuilder, account);
  };
};

type Account = { id: string; role: 'owner' | 'member' | 'guest' };
type State = BaseState & { status: 'published' | 'draft' | 'preview' };

const rules = createPolicy<Account, State>((policy, account) =>
  policy('read')
    .allow({ status: { in: ['published', 'preview'] } }, 'Only published content can be read')
    .allow({ createdBy: account.id }, 'Only the creator can read drafts')
    .forbid(account.role === 'guest', 'Guests cannot read content'),
);
