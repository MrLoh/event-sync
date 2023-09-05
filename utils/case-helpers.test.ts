import { constantCase } from './case-helpers';

describe('constantCase', () => {
  it('transforms camel and pascal case', () => {
    expect(constantCase('camelCaseTest')).toBe('CAMEL_CASE_TEST');
    expect(constantCase('PascalCaseTest')).toBe('PASCAL_CASE_TEST');
  });

  it('transforms snake case', () => {
    expect(constantCase('snake_case_test')).toBe('SNAKE_CASE_TEST');
    expect(constantCase('CONSTANT_CASE_TEST')).toBe('CONSTANT_CASE_TEST');
  });

  it('transforms kebab, dot, and path case', () => {
    expect(constantCase('kebab-case-test')).toBe('KEBAB_CASE_TEST');
    expect(constantCase('dot.case.test')).toBe('DOT_CASE_TEST');
    expect(constantCase('path/case/test')).toBe('PATH_CASE_TEST');
  });

  it('transforms spaces case', () => {
    expect(constantCase('space case test')).toBe('SPACE_CASE_TEST');
    expect(constantCase('Title Case Test')).toBe('TITLE_CASE_TEST');
    expect(constantCase('Sentence case Test')).toBe('SENTENCE_CASE_TEST');
  });

  it('transforms mixed case', () => {
    expect(constantCase('Space Dot.Test')).toBe('SPACE_DOT_TEST');
    expect(constantCase('kebab-PascalTest')).toBe('KEBAB_PASCAL_TEST');
    expect(constantCase('snake_camelTest')).toBe('SNAKE_CAMEL_TEST');
    expect(constantCase('path/camel Test')).toBe('PATH_CAMEL_TEST');
  });

  it('transforms single characters', () => {
    expect(constantCase('')).toBe('');
    expect(constantCase('a')).toBe('A');
    expect(constantCase('1')).toBe('1');
    expect(constantCase('$')).toBe('$');
    expect(constantCase(' ')).toBe('_');
    expect(constantCase('.')).toBe('_');
    expect(constantCase('/')).toBe('_');
    expect(constantCase('-')).toBe('_');
  });
});
