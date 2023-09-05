export type ConstantCase<S extends string> = S extends `${infer First}${infer Rest}`
  ? `${First extends ' ' | '.' | '/' | '-'
      ? '_'
      : First extends Uncapitalize<First>
      ? `${Uppercase<First>}`
      : `_${Uppercase<First>}`}${ConstantCase<Rest>}`
  : S;

export const constantCase = <S extends string>(str: S): ConstantCase<S> => {
  return str
    .replace(/[ ./-]/g, '_')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase() as ConstantCase<S>;
};
