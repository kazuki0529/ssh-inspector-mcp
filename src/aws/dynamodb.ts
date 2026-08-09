import { z } from "zod";

import type { RemoteCommandRunner } from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";
import { buildAwsCommand } from "./build-argv.js";
import { executeAwsJson } from "./execute.js";

const tableNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/);
const attributeValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.object({ S: z.string().max(16_384) }).strict(),
  z.object({ N: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/).max(128) }).strict(),
  z.object({ B: z.string().max(22_000) }).strict(),
  z.object({ BOOL: z.boolean() }).strict(),
  z.object({ NULL: z.literal(true) }).strict(),
  z.object({ SS: z.array(z.string().max(16_384)).min(1).max(100) }).strict(),
  z.object({ NS: z.array(z.string().max(128)).min(1).max(100) }).strict(),
  z.object({ BS: z.array(z.string().max(22_000)).min(1).max(100) }).strict(),
  z.object({ L: z.array(attributeValueSchema).max(100) }).strict(),
  z.object({ M: z.record(z.string().min(1).max(255), attributeValueSchema).refine((value) => Object.keys(value).length <= 100) }).strict(),
]));

const attributeMapSchema = z
  .record(z.string().min(1).max(255), attributeValueSchema)
  .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 100)
  .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 65_536, "attribute mapが大きすぎます");

/** DynamoDB list-tables入力schemaです。 */
export const listTablesInputSchema = z
  .object({ region: z.string(), limit: z.number().int().min(1).max(100).default(100), exclusiveStartTableName: tableNameSchema.optional() })
  .strict();
/** DynamoDB describe-table入力schemaです。 */
export const describeTableInputSchema = z.object({ region: z.string(), table: tableNameSchema }).strict();
/** DynamoDB get-item入力schemaです。 */
export const getItemInputSchema = z
  .object({
    region: z.string(),
    table: tableNameSchema,
    key: attributeMapSchema,
    projectionExpression: z.string().min(1).max(4096).optional(),
    expressionAttributeNames: z.record(z.string().regex(/^#[A-Za-z0-9_]+$/), z.string().min(1).max(255)).refine((value) => Object.keys(value).length <= 100).optional(),
    consistentRead: z.boolean().default(false),
  })
  .strict();
/** DynamoDB query入力schemaです。 */
export const queryInputSchema = z
  .object({
    region: z.string(),
    table: tableNameSchema,
    index: z.string().min(1).max(255).optional(),
    keyConditionExpression: z.string().min(1).max(4096),
    expressionAttributeNames: z.record(z.string().regex(/^#[A-Za-z0-9_]+$/), z.string().min(1).max(255)).refine((value) => Object.keys(value).length <= 100).optional(),
    expressionAttributeValues: attributeMapSchema,
    projectionExpression: z.string().min(1).max(4096).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    consistentRead: z.boolean().default(false),
    scanIndexForward: z.boolean().default(true),
    exclusiveStartKey: attributeMapSchema.optional(),
  })
  .strict();

/** list tables入力型です。 */
export type ListTablesInput = z.infer<typeof listTablesInputSchema>;
/** describe table入力型です。 */
export type DescribeTableInput = z.infer<typeof describeTableInputSchema>;
/** get item入力型です。 */
export type GetItemInput = z.infer<typeof getItemInputSchema>;
/** query入力型です。 */
export type QueryInput = z.infer<typeof queryInputSchema>;

/**
 * DynamoDB入力を固定AWS CLI commandへ変換します。
 */
export class DynamoDbCommandBuilder {
  /**
   * table一覧commandを生成します。
   *
   * @param input list tables入力
   * @returns 固定command
   */
  public listTables(input: ListTablesInput): RemoteCommand {
    return this.#build("list-tables", input.region, { limit: input.limit, "exclusive-start-table-name": input.exclusiveStartTableName });
  }

  /**
   * table metadata参照commandを生成します。
   *
   * @param input describe table入力
   * @returns 固定command
   */
  public describeTable(input: DescribeTableInput): RemoteCommand {
    return this.#build("describe-table", input.region, { "table-name": input.table });
  }

  /**
   * key指定item取得commandを生成します。
   *
   * @param input get item入力
   * @returns 固定command
   */
  public getItem(input: GetItemInput): RemoteCommand {
    return this.#build("get-item", input.region, {
      "table-name": input.table,
      key: input.key,
      "projection-expression": input.projectionExpression,
      "expression-attribute-names": input.expressionAttributeNames,
      "consistent-read": input.consistentRead,
    });
  }

  /**
   * bounded query commandを生成します。
   *
   * @param input query入力
   * @returns 固定command
   */
  public query(input: QueryInput): RemoteCommand {
    return this.#build("query", input.region, {
      "table-name": input.table,
      "index-name": input.index,
      "key-condition-expression": input.keyConditionExpression,
      "expression-attribute-names": input.expressionAttributeNames,
      "expression-attribute-values": input.expressionAttributeValues,
      "projection-expression": input.projectionExpression,
      limit: input.limit,
      "consistent-read": input.consistentRead,
      "scan-index-forward": input.scanIndexForward,
      "exclusive-start-key": input.exclusiveStartKey,
    });
  }

  /**
   * AWS共通policyをDynamoDB operationへ適用します。
   *
   * @param operation API operation
   * @param region AWS region
   * @param parameters operation parameter
   * @returns 固定command
   */
  #build(operation: string, region: string, parameters: Parameters<typeof buildAwsCommand>[0]["parameters"]): RemoteCommand {
    return buildAwsCommand({ service: "dynamodb", operation, region, parameters });
  }
}

/**
 * DynamoDB metadata/get/queryを実行します。
 */
export class DynamoDbService {
  readonly #runner: RemoteCommandRunner;
  readonly #builder: DynamoDbCommandBuilder;

  /**
   * DynamoDB実行依存を固定します。
   *
   * @param runner bounded runner
  * @param builder bounded command builder
   */
  public constructor(runner: RemoteCommandRunner, builder: DynamoDbCommandBuilder) {
    this.#runner = runner;
    this.#builder = builder;
  }

  /**
  * IAMが返したtable一覧を返します。
   *
   * @param input list tables入力
  * @returns AWS JSON
   */
  public async listTables(input: ListTablesInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.listTables(input)) };
  }

  /**
   * table metadataを参照します。
   *
   * @param input describe table入力
   * @returns AWS JSON
   */
  public async describeTable(input: DescribeTableInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.describeTable(input)) };
  }

  /**
   * key指定でitemを取得します。
   *
   * @param input get item入力
   * @returns AWS JSON
   */
  public async getItem(input: GetItemInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.getItem(input)) };
  }

  /**
  * tableまたはindexをqueryします。
   *
   * @param input query入力
   * @returns AWS JSON
   */
  public async query(input: QueryInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.query(input)) };
  }
}