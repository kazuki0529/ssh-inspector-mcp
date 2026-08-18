import { z } from "zod";

import type { RemoteCommandRunner } from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";
import { buildAwsCommand } from "./build-argv.js";
import { executeAwsJson } from "./execute.js";

const tokenSchema = z.string().min(1).max(4096).optional();
const logGroupNameSchema = z.string().min(1).max(512);
const logStreamNameSchema = z.string().min(1).max(512);
const timestampSchema = z.iso.datetime({ offset: true }).optional();

/** CloudWatch Logs log group検索入力schemaです。 */
export const describeLogGroupsInputSchema = z
  .object({
    region: z.string(),
    logGroupNamePrefix: z.string().min(1).max(512).optional(),
    logGroupNamePattern: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(50).default(50),
    nextToken: tokenSchema,
  })
  .strict()
  .refine(
    (input) => input.logGroupNamePrefix === undefined || input.logGroupNamePattern === undefined,
    "logGroupNamePrefixとlogGroupNamePatternは同時指定できません",
  );

/** CloudWatch Logs log stream一覧入力schemaです。 */
export const describeLogStreamsInputSchema = z
  .object({
    region: z.string(),
    logGroupName: logGroupNameSchema,
    logStreamNamePrefix: z.string().min(1).max(512).optional(),
    orderBy: z.enum(["LogStreamName", "LastEventTime"]).default("LogStreamName"),
    descending: z.boolean().default(true),
    limit: z.number().int().min(1).max(50).default(50),
    nextToken: tokenSchema,
  })
  .strict()
  .refine(
    (input) => input.logStreamNamePrefix === undefined || input.orderBy === "LogStreamName",
    "logStreamNamePrefix指定時のorderByはLogStreamNameだけです",
  );

/** CloudWatch Logs event検索入力schemaです。 */
export const filterLogEventsInputSchema = z
  .object({
    region: z.string(),
    logGroupName: logGroupNameSchema,
    logStreamNames: z.array(logStreamNameSchema).min(1).max(100).optional(),
    logStreamNamePrefix: z.string().min(1).max(512).optional(),
    startTime: timestampSchema,
    endTime: timestampSchema,
    filterPattern: z.string().max(1024).optional(),
    limit: z.number().int().min(1).max(100).default(100),
    nextToken: tokenSchema,
  })
  .strict()
  .refine(
    (input) => input.logStreamNames === undefined || input.logStreamNamePrefix === undefined,
    "logStreamNamesとlogStreamNamePrefixは同時指定できません",
  )
  .superRefine(validateTimeRange);

/** CloudWatch Logs単一stream取得入力schemaです。 */
export const getLogEventsInputSchema = z
  .object({
    region: z.string(),
    logGroupName: logGroupNameSchema,
    logStreamName: logStreamNameSchema,
    startTime: timestampSchema,
    endTime: timestampSchema,
    startFromHead: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(100),
    nextToken: tokenSchema,
  })
  .strict()
  .superRefine(validateTimeRange);

/** log group検索入力型です。 */
export type DescribeLogGroupsInput = z.infer<typeof describeLogGroupsInputSchema>;
/** log stream一覧入力型です。 */
export type DescribeLogStreamsInput = z.infer<typeof describeLogStreamsInputSchema>;
/** log event検索入力型です。 */
export type FilterLogEventsInput = z.infer<typeof filterLogEventsInputSchema>;
/** 単一stream event取得入力型です。 */
export type GetLogEventsInput = z.infer<typeof getLogEventsInputSchema>;

/**
 * CloudWatch Logs入力を固定AWS CLI commandへ変換します。
 */
export class CloudWatchLogsCommandBuilder {
  /**
   * log group metadataの検索commandを生成します。
   *
   * @param input 検証済み入力
   * @returns 固定AWS CLI command
   */
  public describeLogGroups(input: DescribeLogGroupsInput): RemoteCommand {
    return this.#build("describe-log-groups", input.region, {
      "log-group-name-prefix": input.logGroupNamePrefix,
      "log-group-name-pattern": input.logGroupNamePattern,
      limit: input.limit,
      "next-token": input.nextToken,
    });
  }

  /**
   * log stream metadata一覧commandを生成します。
   *
   * @param input 検証済み入力
   * @returns 固定AWS CLI command
   */
  public describeLogStreams(input: DescribeLogStreamsInput): RemoteCommand {
    return this.#build("describe-log-streams", input.region, {
      "log-group-name": input.logGroupName,
      "log-stream-name-prefix": input.logStreamNamePrefix,
      "order-by": input.orderBy,
      descending: input.descending,
      limit: input.limit,
      "next-token": input.nextToken,
    });
  }

  /**
   * 複数streamを対象にevent本文を検索するcommandを生成します。
   *
   * @param input 検証済み入力
   * @returns 固定AWS CLI command
   */
  public filterLogEvents(input: FilterLogEventsInput): RemoteCommand {
    return this.#build("filter-log-events", input.region, {
      "log-group-name": input.logGroupName,
      "log-stream-names": input.logStreamNames,
      "log-stream-name-prefix": input.logStreamNamePrefix,
      "start-time": toEpochMilliseconds(input.startTime),
      "end-time": toEpochMilliseconds(input.endTime),
      "filter-pattern": input.filterPattern,
      limit: input.limit,
      "next-token": input.nextToken,
    });
  }

  /**
   * 単一streamからevent本文を取得するcommandを生成します。
   *
   * @param input 検証済み入力
   * @returns 固定AWS CLI command
   */
  public getLogEvents(input: GetLogEventsInput): RemoteCommand {
    return this.#build("get-log-events", input.region, {
      "log-group-name": input.logGroupName,
      "log-stream-name": input.logStreamName,
      "start-time": toEpochMilliseconds(input.startTime),
      "end-time": toEpochMilliseconds(input.endTime),
      "start-from-head": input.startFromHead,
      limit: input.limit,
      "next-token": input.nextToken,
    });
  }

  /**
   * AWS共通policyをCloudWatch Logs operationへ適用します。
   *
   * @param operation API operation
   * @param region AWS region
   * @param parameters operation parameter
   * @returns 固定command
   */
  #build(
    operation: string,
    region: string,
    parameters: Parameters<typeof buildAwsCommand>[0]["parameters"],
  ): RemoteCommand {
    return buildAwsCommand({
      service: "logs",
      operation,
      region,
      parameters,
    });
  }
}

/**
 * CloudWatch Logs metadataとbounded event本文参照を実行します。
 */
export class CloudWatchLogsService {
  readonly #runner: RemoteCommandRunner;
  readonly #builder: CloudWatchLogsCommandBuilder;

  /**
  * bounded runnerとcommand builderを固定します。
   *
   * @param runner bounded command runner
  * @param builder bounded command builder
   */
  public constructor(runner: RemoteCommandRunner, builder: CloudWatchLogsCommandBuilder) {
    this.#runner = runner;
    this.#builder = builder;
  }

  /**
   * log group metadataをprefixまたはpatternで検索します。
   *
   * @param input log group検索入力
   * @returns AWS JSON
   */
  public async describeLogGroups(input: DescribeLogGroupsInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.describeLogGroups(input)) };
  }

  /**
   * 指定log groupのstream metadataを一覧します。
   *
   * @param input stream一覧入力
   * @returns AWS JSON
   */
  public async describeLogStreams(input: DescribeLogStreamsInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.describeLogStreams(input)) };
  }

  /**
   * 指定条件に一致するlog eventsを検索します。
   *
   * @param input event検索入力
   * @returns AWS JSON
   */
  public async filterLogEvents(input: FilterLogEventsInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.filterLogEvents(input)) };
  }

  /**
   * 単一streamのlog eventsを取得します。
   *
   * @param input 単一stream取得入力
   * @returns AWS JSON
   */
  public async getLogEvents(input: GetLogEventsInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.getLogEvents(input)) };
  }
}

/**
 * endTimeがstartTimeより後であることを検証します。
 *
 * @param input 任意の開始・終了時刻
 * @param context Zod検証context
 */
function validateTimeRange(
  input: { startTime?: string | undefined; endTime?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (input.startTime === undefined || input.endTime === undefined) {
    return;
  }

  const duration = new Date(input.endTime).getTime() - new Date(input.startTime).getTime();
  if (duration <= 0) {
    context.addIssue({ code: "custom", path: ["endTime"], message: "endTimeはstartTimeより後である必要があります" });
  }
}

/**
 * ISO日時をAWS Logs APIのepoch millisecondsへ変換します。
 *
 * @param value 任意のISO日時
 * @returns 未指定ならundefined
 */
function toEpochMilliseconds(value: string | undefined): number | undefined {
  return value === undefined ? undefined : new Date(value).getTime();
}