import has from 'lodash/has';
import cloneDeepWith from 'lodash/cloneDeepWith';

import { mixed as locale } from './locale';
import Condition, { ConditionOptions, ResolveOptions } from './Condition';
import runTests from './util/runTests';
import merge from './util/prependDeep';
import isSchema from './util/isSchema';
import createValidation, {
  TestFunction,
  Test,
  TestConfig,
} from './util/createValidation';
import printValue from './util/printValue';
import Ref from './Reference';
import { getIn } from './util/reach';
import Reference from './Reference';
import toArray from './util/toArray';
import {
  ValidateOptions,
  TransformFunction,
  Message,
  Callback,
  InternalOptions,, Maybe
} from './types';
import Schema, {
  CastOptions,
  SchemaRefDescription,
  SchemaDescription,
} from './Schema';
import { ValidationError } from '.';
import { ResolveInput, ResolveOutput, SetNullability, TypeDef } from './util/types';

class RefSet {
  list: Set<unknown>;
  refs: Map<string, Reference>;

  constructor() {
    this.list = new Set();
    this.refs = new Map();
  }
  get size() {
    return this.list.size + this.refs.size;
  }
  describe() {
    const description = [] as Array<unknown | SchemaRefDescription>;

    for (const item of this.list) description.push(item);
    for (const [, ref] of this.refs) description.push(ref.describe());

    return description;
  }
  toArray() {
    return Array.from(this.list).concat(Array.from(this.refs.values()));
  }
  add(value: unknown) {
    Ref.isRef(value) ? this.refs.set(value.key, value) : this.list.add(value);
  }
  delete(value: unknown) {
    Ref.isRef(value) ? this.refs.delete(value.key) : this.list.delete(value);
  }
  has(value: unknown, resolve: (v: unknown) => unknown) {
    if (this.list.has(value)) return true;

    let item,
      values = this.refs.values();
    while (((item = values.next()), !item.done))
      if (resolve(item.value) === value) return true;

    return false;
  }
  clone() {
    const next = new RefSet();
    next.list = new Set(this.list);
    next.refs = new Map(this.refs);
    return next;
  }
  merge(newItems: RefSet, removeItems: RefSet) {
    const next = this.clone();
    newItems.list.forEach((value) => next.add(value));
    newItems.refs.forEach((value) => next.add(value));
    removeItems.list.forEach((value) => next.delete(value));
    removeItems.refs.forEach((value) => next.delete(value));
    return next;
  }
}

const UNSET = '@@UNSET_DEFAULT';

// export type TypeDef<T extends any = any> = {
//   nullable: boolean;
//   required: boolean;
//   default: T;
// };

export type SchemaSpec<TDefault = undefined> = {
  nullable?: boolean;
  default: TDefault;
  hasDefault?: boolean;
  abortEarly?: boolean;
  strip?: boolean;
  strict?: boolean;
  recursive?: boolean;
  label?: string | undefined;
  meta?: any;
};

export type SchemaOptions<TDefault = undefined> = {
  type?: string;
  spec: SchemaSpec<TDefault>;
};

export function create() {
  return new MixedSchema();
}

export default class MixedSchema<
  TType = any,
  TDef extends TypeDef = 'optional' | 'nonnullable',
  TDefault extends Maybe<TType> = undefined,
> implements Schema {
  readonly type: string;

  readonly __inputType!: ResolveInput<TType, TDef, TDefault>;
  readonly __outputType!: ResolveOutput<TType, TDef, TDefault>;

  readonly __isYupSchema__ = true;

  readonly deps: readonly string[] = [];
  protected _exclusive: Record<string, unknown> = Object.create(null);

  protected _whitelist: RefSet = new RefSet();
  protected _blacklist: RefSet = new RefSet();

  tests: Test[];
  transforms: TransformFunction<this>[]; // TODO

  private _mutate?: boolean;

  protected _label?: string;
  protected _meta: any;
  private conditions: Condition[] = [];
  // protected configuredDefault: ((this: this) => unknown) | undefined;

  // private _validating: boolean = false;
  private _typeError?: Test;
  private _whitelistError?: Test;
  private _blacklistError?: Test;

  optional!: () => MixedSchema;

  spec: SchemaSpec<TDefault>;

  // static create<T extends MixedSchema>(
  //   this: new (...args: any[]) => T,
  //   ...args: any[]
  // ) {
  //   return new this(...args);
  // }

  constructor(options?: SchemaOptions<TDefault>) {
    this.tests = [];
    this.transforms = [];

    this.withMutation(() => {
      this.typeError(locale.notType);
    });

    this.type = options?.type || ('mixed' as const);

    this.spec = {
      // __def: null as any,
      hasDefault: false,
      strip: false,
      strict: false,
      abortEarly: true,
      recursive: true,
      // noUnknown: false,

      label: undefined,
      meta: undefined,
      nullable: false,
      // required: false,
      default: undefined as any,
      ...options?.spec,
    };
  }

  // TODO: remove
  get _type() {
    return this.type;
  }

  protected _typeCheck(_: any) {
    return true;
  }

  // __isYupSchema__ = true;

  clone(): this {
    if (this._mutate) return this;

    // if the nested value is a schema we can skip cloning, since
    // they are already immutable
    return cloneDeepWith(this, (value) => {
      if (isSchema(value) && value !== this) return value;
    });
  }

  label(label: string) {
    var next = this.clone();
    next._label = label;
    return next;
  }

  meta(obj: {}) {
    if (arguments.length === 0) return this._meta;

    var next = this.clone();
    next._meta = Object.assign(next._meta || {}, obj);
    return next;
  }

  withMutation<T>(fn: (schema: this) => T): T {
    let before = this._mutate;
    this._mutate = true;
    let result = fn(this);
    this._mutate = before;
    return result;
  }

  concat(schema: MixedSchema): MixedSchema {
    // @ts-ignore
    if (!schema || schema === this) return this;

    if (schema.type !== this.type && this.type !== 'mixed')
      throw new TypeError(
        `You cannot \`concat()\` schema's of different types: ${this.type} and ${schema.type}`,
      );

    var next = merge(schema.clone() as any, this as any) as this;

    // new undefined default is overridden by old non-undefined one, revert
    if (schema.spec.hasDefault) {
      next.spec.default = schema.spec.default;
    }

    next.tests = this.tests;
    next._exclusive = this._exclusive;

    // manually merge the blacklist/whitelist (the other `schema` takes
    // precedence in case of conflicts)
    next._whitelist = this._whitelist.merge(
      schema._whitelist,
      schema._blacklist,
    );
    next._blacklist = this._blacklist.merge(
      schema._blacklist,
      schema._whitelist,
    );

    // manually add the new tests to ensure
    // the deduping logic is consistent
    next.withMutation((next) => {
      schema.tests.forEach((fn) => {
        next.test(fn.OPTIONS);
      });
    });

    return next;
  }

  // abstract ?(value: any): boolean;

  isType(v: any) {
    if (this.spec.nullable && v === null) return true;
    return this._typeCheck(v);
  }

  resolve(options: ResolveOptions) {
    let schema = this;

    if (schema.conditions.length) {
      let conditions = schema.conditions;

      schema = schema.clone();
      schema.conditions = [];
      schema = conditions.reduce(
        (schema, condition) => condition.resolve(schema, options),
        schema,
      );

      schema = schema.resolve(options);
    }

    return schema;
  }

  /**
   *
   * @param {*} value
   * @param {Object} options
   * @param {*=} options.parent
   * @param {*=} options.context
   */
  cast(value: any, options: CastOptions = {}): ResolveInput<TType, TDef> {
    let resolvedSchema = this.resolve({
      value,
      ...options,
      // parent: options.parent,
      // context: options.context,
    });

    let result = resolvedSchema._cast(value, options);

    if (
      value !== undefined &&
      options.assert !== false &&
      resolvedSchema.isType(result) !== true
    ) {
      let formattedValue = printValue(value);
      let formattedResult = printValue(result);
      throw new TypeError(
        `The value of ${
          options.path || 'field'
        } could not be cast to a value ` +
          `that satisfies the schema type: "${resolvedSchema._type}". \n\n` +
          `attempted value: ${formattedValue} \n` +
          (formattedResult !== formattedValue
            ? `result of cast: ${formattedResult}`
            : ''),
      );
    }

    return result;
  }

  protected _cast(rawValue: any, _options: CastOptions) {
    let value =
      rawValue === undefined
        ? rawValue
        : this.transforms.reduce(
            (value, fn) => fn.call(this, value, rawValue),
            rawValue,
          );

    if (value === undefined && this.spec.default !== UNSET) {
      value = this.default();
    }

    return value;
  }

  protected _validate(
    _value: any,
    options: InternalOptions = {},
    cb: Callback,
  ): void {
    let {
      sync,
      path,
      from = [],
      originalValue = _value,
      strict = this.spec.strict,
      abortEarly = this.spec.abortEarly,
    } = options;

    let value = _value;
    if (!strict) {
      // this._validating = true;
      value = this._cast(value, { assert: false, ...options });
      // this._validating = false;
    }
    // value is cast, we can check if it meets type requirements
    let args = {
      value,
      path,
      options,
      originalValue,
      schema: this,
      label: this._label,
      sync,
      from,
    };

    let initialTests = [];

    if (this._typeError) initialTests.push(this._typeError);
    if (this._whitelistError) initialTests.push(this._whitelistError);
    if (this._blacklistError) initialTests.push(this._blacklistError);

    runTests(
      {
        args,
        value,
        path,
        sync,
        tests: initialTests,
        endEarly: abortEarly,
      },
      (err) => {
        if (err) return void cb(err, value);

        runTests(
          {
            tests: this.tests,
            args,
            path,
            sync,
            value,
            endEarly: abortEarly,
          },
          cb,
        );
      },
    );
  }

  validate(
    value: any,
    options?: ValidateOptions,
  ): Promise<ResolveOutput<TType, TDef>>;
  validate(value: any, options: ValidateOptions = {}, maybeCb?: Callback) {
    let schema = this.resolve({ ...options, value });

    // callback case is for nested validations
    return typeof maybeCb === 'function'
      ? schema._validate(value, options, maybeCb)
      : new Promise((resolve, reject) =>
          schema._validate(value, options, (err, value) => {
            if (err) reject(err);
            else resolve(value);
          }),
        );
  }

  validateSync(
    value: any,
    options: ValidateOptions = {},
  ): ResolveOutput<TType, TDef> {
    let schema = this.resolve({ ...options, value });
    let result: any;

    schema._validate(value, { ...options, sync: true }, (err, value) => {
      if (err) throw err;
      result = value;
    });

    return result;
  }

  isValid(value: any, options: ValidateOptions): Promise<boolean> {
    return this.validate(value, options)
      .then(() => true)
      .catch((err) => {
        if (ValidationError.isError(err)) return false;
        throw err;
      });
  }

  isValidSync(value: any, options: ValidateOptions): boolean {
    try {
      this.validateSync(value, options);
      return true;
    } catch (err) {
      if (ValidationError.isError(err)) return false;
      throw err;
    }
  }

  getDefault(options = {}) {
    let schema = this.resolve(options);
    return schema.default();
  }

  default(): TDefault; // FIXME(ts): typed default
  default<TNextDefault extends Maybe<TType>>(
    def: TNextDefault | (() => TNextDefault),
  ): MixedSchema<TType, TDef, TNextDefault>
  default<TDefault = any>(def?: TDefault | (() => TDefault)) {
    if (arguments.length === 0) {
      let defaultValue = this.spec.default;

      if (defaultValue == null) {
        return defaultValue;
      }

      return typeof defaultValue === 'function'
        ? defaultValue.call(this)
        : cloneDeepWith(defaultValue);
    }

    var next = this.clone();
    next.spec.hasDefault = true;
    next.spec.default = def as any;
    return next;
  }

  strict(isStrict = true) {
    var next = this.clone();
    next.spec.strict = isStrict;
    return next;
  }

  protected _isPresent(value: unknown) {
    return value != null;
  }

  required(
    message = locale.required,
  ): MixedSchema<TType, Exclude<TDef, 'optional'> | 'required'> {
    return this.test({
      message,
      name: 'required',
      exclusive: true,
      test(value) {
        return this.schema._isPresent(value);
      },
    }) as any;
  }

  notRequired(): MixedSchema<TType, Exclude<TDef, 'required'> | 'optional'> {
    var next = this.clone();
    next.tests = next.tests.filter((test) => test.OPTIONS.name !== 'required');
    return next as any;
  }

  nullable(
    isNullable?: true,
  ): MixedSchema<TType, SetNullability<TDef, 'nullable'>, TDefault>;
  nullable(
    isNullable: false,
  ): MixedSchema<TType, SetNullability<TDef, 'nonnullable'>, TDefault>;
  nullable(isNullable = true): MixedSchema<TType, any, TDefault> {
    var next = this.clone();
    next.spec.nullable = isNullable;
    return next as any;
  }

  transform(fn: TransformFunction<this>) {
    var next = this.clone();
    next.transforms.push(fn);
    return next;
  }

  /**
   * Adds a test function to the schema's queue of tests.
   * tests can be exclusive or non-exclusive.
   *
   * - exclusive tests, will replace any existing tests of the same name.
   * - non-exclusive: can be stacked
   *
   * If a non-exclusive test is added to a schema with an exclusive test of the same name
   * the exclusive test is removed and further tests of the same name will be stacked.
   *
   * If an exclusive test is added to a schema with non-exclusive tests of the same name
   * the previous tests are removed and further tests of the same name will replace each other.
   */
  test(options: TestConfig): this;
  test(test: TestFunction): this;
  test(name: string, test: TestFunction): this;
  test(name: string, message: Message, test: TestFunction): this;
  test(...args: any[]) {
    let opts: TestConfig;

    if (args.length === 1) {
      if (typeof args[0] === 'function') {
        opts = { test: args[0] };
      } else {
        opts = args[0];
      }
    } else if (args.length === 2) {
      opts = { name: args[0], test: args[1] };
    } else {
      opts = { name: args[0], message: args[1], test: args[2] };
    }

    if (opts.message === undefined) opts.message = locale.default;

    if (typeof opts.test !== 'function')
      throw new TypeError('`test` is a required parameters');

    let next = this.clone();
    let validate = createValidation(opts);

    let isExclusive =
      opts.exclusive || (opts.name && next._exclusive[opts.name] === true);

    if (opts.exclusive) {
      if (!opts.name)
        throw new TypeError(
          'Exclusive tests must provide a unique `name` identifying the test',
        );
    }

    if (opts.name) next._exclusive[opts.name] = !!opts.exclusive;

    next.tests = next.tests.filter((fn) => {
      if (fn.OPTIONS.name === opts.name) {
        if (isExclusive) return false;
        if (fn.OPTIONS.test === validate.OPTIONS.test) return false;
      }
      return true;
    });

    next.tests.push(validate);

    return next;
  }

  when(options: ConditionOptions<this>): this;
  when(keys: string | string[], options: ConditionOptions<this>): this;
  when(
    keys: string | string[] | ConditionOptions<this>,
    options?: ConditionOptions<this>,
  ) {
    if (!Array.isArray(keys) && typeof keys !== 'string') {
      options = keys;
      keys = '.';
    }

    let next = this.clone();
    let deps = toArray(keys).map((key) => new Ref(key));

    deps.forEach((dep) => {
      // @ts-ignore
      if (dep.isSibling) next.deps.push(dep.key);
    });

    next.conditions.push(new Condition<this>(deps, options!));

    return next;
  }

  typeError(message: Message) {
    var next = this.clone();

    next._typeError = createValidation({
      message,
      name: 'typeError',
      test(value) {
        if (value !== undefined && !this.schema.isType(value))
          return this.createError({
            params: {
              type: this.schema._type,
            },
          });
        return true;
      },
    });
    return next;
  }

  oneOf(enums: unknown[], message = locale.oneOf) {
    var next = this.clone();

    enums.forEach((val) => {
      next._whitelist.add(val);
      next._blacklist.delete(val);
    });

    next._whitelistError = createValidation({
      message,
      name: 'oneOf',
      test(value) {
        if (value === undefined) return true;
        let valids = this.schema._whitelist;

        return valids.has(value, this.resolve)
          ? true
          : this.createError({
              params: {
                values: valids.toArray().join(', '),
              },
            });
      },
    });

    return next;
  }

  notOneOf(enums: unknown[], message = locale.notOneOf) {
    var next = this.clone();
    enums.forEach((val) => {
      next._blacklist.add(val);
      next._whitelist.delete(val);
    });

    next._blacklistError = createValidation({
      message,
      name: 'notOneOf',
      test(value) {
        let invalids = this.schema._blacklist;
        if (invalids.has(value, this.resolve))
          return this.createError({
            params: {
              values: invalids.toArray().join(', '),
            },
          });
        return true;
      },
    });

    return next;
  }

  strip(strip = true) {
    let next = this.clone();
    next.spec.strip = strip;
    return next;
  }

  describe() {
    const next = this.clone();
    const description: SchemaDescription = {
      type: next._type,
      meta: next._meta,
      label: next._label,
      oneOf: next._whitelist.describe(),
      notOneOf: next._blacklist.describe(),
      tests: next.tests
        .map((fn) => ({ name: fn.OPTIONS.name, params: fn.OPTIONS.params }))
        .filter(
          (n, idx, list) => list.findIndex((c) => c.name === n.name) === idx,
        ),
    };

    return description;
  }

  defined(message = locale.defined) {
    return this.test({
      message,
      name: 'defined',
      exclusive: true,
      test(value) {
        return value !== undefined;
      },
    });
  }
}

for (const method of ['validate', 'validateSync'])
  MixedSchema.prototype[`${method}At`] = function (
    path: string,
    value: any,
    options: ValidateOptions = {},
  ) {
    const { parent, parentPath, schema } = getIn(
      this,
      path,
      value,
      options.context,
    );
    return schema[method](parent && parent[parentPath], {
      ...options,
      parent,
      path,
    });
  };

for (const alias of ['equals', 'is'] as const)
  MixedSchema.prototype[alias] = MixedSchema.prototype.oneOf;

for (const alias of ['not', 'nope'] as const)
  MixedSchema.prototype[alias] = MixedSchema.prototype.notOneOf;

MixedSchema.prototype.optional = MixedSchema.prototype.notRequired;

type WithSpec<T extends MixedSchema, TSpec extends Partial<SchemaSpec>> = T & {
  spec: T['spec'] & TSpec;
};