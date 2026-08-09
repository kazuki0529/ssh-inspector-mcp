import { z } from "zod";

import type { RemoteCommandRunner } from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";
import { buildAwsCommand } from "./build-argv.js";
import { executeAwsJson } from "./execute.js";

const tokenSchema = z.string().min(1).max(4096).optional();

/** CloudWatch dimension入力schemaです。 */
export const cloudWatchDimensionSchema = z
  .object({
    name: z.string().min(1).max(255),
    value: z.string().min(1).max(1024),
  })
  .strict();

/** describe-alarms入力schemaです。 */
export const describeAlarmsInputSchema = z
  .object({
    region: z.string(),
    alarmNamePrefix: z.string().min(1).max(255).optional(),
    stateValue: z.enum(["OK", "ALARM", "INSUFFICIENT_DATA"]).optional(),
    maxRecords: z.number().int().min(1).max(100).default(50),
    nextToken: tokenSchema,
  })
  .strict();

/** list-metrics入力schemaです。 */
export const listMetricsInputSchema = z
  .object({
    region: z.string(),
    namespace: z.string().min(1).max(255).optional(),
    metricName: z.string().min(1).max(255).optional(),
    dimensions: z.array(cloudWatchDimensionSchema).max(10).default([]),
    recentlyActive: z.literal("PT3H").optional(),
    nextToken: tokenSchema,
  })
  .strict();

const metricStatSchema = z
  .object({
    metric: z
      .object({
        namespace: z.string().min(1).max(255),
        metricName: z.string().min(1).max(255),
        dimensions: z.array(cloudWatchDimensionSchema).max(10).default([]),
      })
      .strict(),
    period: z.number().int().min(1).max(86_400),
    stat: z.string().min(1).max(255),
    unit: z.string().min(1).max(32).optional(),
  })
  .strict();

const metricDataQuerySchema = z
  .object({
    id: z.string().regex(/^[a-z][A-Za-z0-9_]{0,254}$/),
    label: z.string().max(1024).optional(),
    returnData: z.boolean().default(true),
    expression: z.string().min(1).max(2048).optional(),
    metricStat: metricStatSchema.optional(),
  })
  .strict()
  .refine((query) => Number(query.expression !== undefined) + Number(query.metricStat !== undefined) === 1, {
    message: "expressionまたはmetricStatのどちらか一方が必要です",
  });

/** get-metric-data入力schemaです。 */
export const getMetricDataInputSchema = z
  .object({
    region: z.string(),
    startTime: z.iso.datetime({ offset: true }),
    endTime: z.iso.datetime({ offset: true }),
    queries: z.array(metricDataQuerySchema).min(1).max(100),
    scanBy: z.enum(["TimestampAscending", "TimestampDescending"]).default("TimestampDescending"),
    maxDatapoints: z.number().int().min(1).max(10_800).default(1_000),
    nextToken: tokenSchema,
  })
  .strict()
  .refine((input) => new Date(input.startTime).getTime() < new Date(input.endTime).getTime(), {
    message: "startTimeはendTimeより前である必要があります",
  })
  .refine(
    (input) => new Date(input.endTime).getTime() - new Date(input.startTime).getTime() <= 31 * 24 * 60 * 60 * 1_000,
    { message: "metric dataの時間範囲は31日以内に制限してください" },
  );

/** describe-alarms入力型です。 */
export type DescribeAlarmsInput = z.infer<typeof describeAlarmsInputSchema>;
/** list-metrics入力型です。 */
export type ListMetricsInput = z.infer<typeof listMetricsInputSchema>;
/** get-metric-data入力型です。 */
export type GetMetricDataInput = z.infer<typeof getMetricDataInputSchema>;

/**
 * CloudWatch入力を固定AWS CLI commandへ変換します。
 */
export class CloudWatchCommandBuilder {
  /**
   * alarm metadata参照commandを生成します。
   *
   * @param input describe alarms入力
   * @returns 固定AWS CLI command
   */
  public describeAlarms(input: DescribeAlarmsInput): RemoteCommand {
    return buildAwsCommand({
      service: "cloudwatch",
      operation: "describe-alarms",
      region: input.region,
      parameters: {
        "alarm-name-prefix": input.alarmNamePrefix,
        "state-value": input.stateValue,
        "max-records": input.maxRecords,
        "next-token": input.nextToken,
      },
    });
  }

  /**
   * metric metadata参照commandを生成します。
   *
   * @param input list metrics入力
   * @returns 固定AWS CLI command
   */
  public listMetrics(input: ListMetricsInput): RemoteCommand {
    return buildAwsCommand({
      service: "cloudwatch",
      operation: "list-metrics",
      region: input.region,
      parameters: {
        namespace: input.namespace,
        "metric-name": input.metricName,
        dimensions: input.dimensions.map((dimension) => `Name=${dimension.name},Value=${dimension.value}`),
        "recently-active": input.recentlyActive,
        "next-token": input.nextToken,
      },
    });
  }

  /**
   * metric data参照commandを生成します。
   *
   * @param input metric data入力
   * @returns 固定AWS CLI command
   */
  public getMetricData(input: GetMetricDataInput): RemoteCommand {
    const queries = input.queries.map((query) => ({
      Id: query.id,
      ...(query.label === undefined ? {} : { Label: query.label }),
      ReturnData: query.returnData,
      ...(query.expression === undefined ? {} : { Expression: query.expression }),
      ...(query.metricStat === undefined ? {} : { MetricStat: mapMetricStat(query.metricStat) }),
    }));

    return buildAwsCommand({
      service: "cloudwatch",
      operation: "get-metric-data",
      region: input.region,
      parameters: {
        "start-time": input.startTime,
        "end-time": input.endTime,
        "metric-data-queries": queries,
        "scan-by": input.scanBy,
        "max-datapoints": input.maxDatapoints,
        "next-token": input.nextToken,
      },
    });
  }
}

/**
 * CloudWatch参照operationを実行し、AWS JSONをそのまま構造化結果へ渡します。
 */
export class CloudWatchService {
  readonly #runner: RemoteCommandRunner;
  readonly #builder: CloudWatchCommandBuilder;

  /**
  * bounded runnerとcommand builderを固定します。
   *
   * @param runner bounded command runner
  * @param builder bounded command builder
   */
  public constructor(runner: RemoteCommandRunner, builder: CloudWatchCommandBuilder) {
    this.#runner = runner;
    this.#builder = builder;
  }

  /**
   * alarm metadataを参照します。
   *
   * @param input describe alarms入力
   * @returns AWS JSON
   */
  public async describeAlarms(input: DescribeAlarmsInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.describeAlarms(input)) };
  }

  /**
   * metric metadataを参照します。
   *
   * @param input list metrics入力
   * @returns AWS JSON
   */
  public async listMetrics(input: ListMetricsInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.listMetrics(input)) };
  }

  /**
   * metric dataを参照します。
   *
   * @param input metric data入力
   * @returns AWS JSON
   */
  public async getMetricData(input: GetMetricDataInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.getMetricData(input)) };
  }
}

/**
 * metric statをAWS API field名へ明示変換します。
 *
 * @param metricStat 検証済み入力
 * @returns AWS CLI JSON parameter
 */
function mapMetricStat(metricStat: z.infer<typeof metricStatSchema>): object {
  return {
    Metric: {
      Namespace: metricStat.metric.namespace,
      MetricName: metricStat.metric.metricName,
      Dimensions: metricStat.metric.dimensions.map((dimension) => ({
        Name: dimension.name,
        Value: dimension.value,
      })),
    },
    Period: metricStat.period,
    Stat: metricStat.stat,
    ...(metricStat.unit === undefined ? {} : { Unit: metricStat.unit }),
  };
}