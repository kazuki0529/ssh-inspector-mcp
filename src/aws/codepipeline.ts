import { z } from "zod";

import type { RemoteCommandRunner } from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";
import { buildAwsCommand } from "./build-argv.js";
import { executeAwsJson } from "./execute.js";

const pipelineNameSchema = z.string().regex(/^[A-Za-z0-9.@_-]{1,100}$/);
const executionIdSchema = z.string().uuid();
const tokenSchema = z.string().min(1).max(4096).optional();
const limitSchema = z.number().int().min(1).max(100).default(50);

/** pipeline一覧入力schemaです。 */
export const listPipelinesInputSchema = z
  .object({ region: z.string(), limit: limitSchema, nextToken: tokenSchema })
  .strict();

/** pipeline state入力schemaです。 */
export const getPipelineStateInputSchema = z
  .object({ region: z.string(), pipeline: pipelineNameSchema })
  .strict();

/** pipeline execution一覧入力schemaです。 */
export const listPipelineExecutionsInputSchema = z
  .object({
    region: z.string(),
    pipeline: pipelineNameSchema,
    mode: z.enum(["latest", "failed", "all"]).default("latest"),
    limit: limitSchema,
    nextToken: tokenSchema,
  })
  .strict();

/** pipeline execution詳細入力schemaです。 */
export const getPipelineExecutionInputSchema = z
  .object({ region: z.string(), pipeline: pipelineNameSchema, executionId: executionIdSchema })
  .strict();

/** action execution一覧入力schemaです。 */
export const listActionExecutionsInputSchema = z
  .object({
    region: z.string(),
    pipeline: pipelineNameSchema,
    executionId: executionIdSchema.optional(),
    limit: limitSchema,
    nextToken: tokenSchema,
  })
  .strict();

/** pipeline一覧入力型です。 */
export type ListPipelinesInput = z.infer<typeof listPipelinesInputSchema>;
/** pipeline state入力型です。 */
export type GetPipelineStateInput = z.infer<typeof getPipelineStateInputSchema>;
/** pipeline execution一覧入力型です。 */
export type ListPipelineExecutionsInput = z.infer<typeof listPipelineExecutionsInputSchema>;
/** pipeline execution詳細入力型です。 */
export type GetPipelineExecutionInput = z.infer<typeof getPipelineExecutionInputSchema>;
/** action execution一覧入力型です。 */
export type ListActionExecutionsInput = z.infer<typeof listActionExecutionsInputSchema>;

/** CodePipeline APIの診断fieldだけを保持するschemaです。 */
const pipelineSchema = z.object({
  name: z.string().optional(),
  version: z.number().optional(),
  pipelineType: z.string().optional(),
  executionMode: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
}).strip();

const errorDetailsSchema = z.object({ code: z.string().optional(), message: z.string().optional() }).strip();
const latestExecutionSchema = z.object({
  actionExecutionId: z.string().optional(),
  status: z.string().optional(),
  statusSummary: z.string().optional(),
  lastStatusChange: z.string().optional(),
}).strip();
const actionStateSchema = z.object({
  actionName: z.string().optional(),
  latestExecution: latestExecutionSchema.optional(),
  errorDetails: errorDetailsSchema.optional(),
}).strip();
const stageStateSchema = z.object({
  stageName: z.string().optional(),
  inboundExecution: z.object({ pipelineExecutionId: z.string().optional(), status: z.string().optional() }).strip().optional(),
  latestExecution: z.object({ pipelineExecutionId: z.string().optional(), status: z.string().optional() }).strip().optional(),
  actionStates: z.array(actionStateSchema).max(100).optional(),
}).strip();
const pipelineExecutionSummarySchema = z.object({
  pipelineExecutionId: z.string().optional(),
  status: z.string().optional(),
  statusSummary: z.string().optional(),
  startTime: z.string().optional(),
  lastUpdateTime: z.string().optional(),
  sourceRevisions: z.array(z.object({ actionName: z.string().optional(), revisionId: z.string().optional(), revisionSummary: z.string().optional() }).strip()).max(100).optional(),
}).strip();
const actionExecutionSchema = z.object({
  pipelineExecutionId: z.string().optional(),
  actionExecutionId: z.string().optional(),
  pipelineVersion: z.number().optional(),
  stageName: z.string().optional(),
  actionName: z.string().optional(),
  startTime: z.string().optional(),
  lastUpdateTime: z.string().optional(),
  status: z.string().optional(),
  input: z.object({
    actionTypeId: z.object({ category: z.string().optional(), owner: z.string().optional(), provider: z.string().optional(), version: z.string().optional() }).strip().optional(),
    region: z.string().optional(),
    namespace: z.string().optional(),
  }).strip().optional(),
  output: z.object({
    executionResult: z.object({ externalExecutionId: z.string().optional(), externalExecutionSummary: z.string().optional() }).strip().optional(),
    errorDetails: errorDetailsSchema.optional(),
  }).strip().optional(),
}).strip();

/**
 * CodePipeline入力を固定AWS CLI commandへ変換します。
 */
export class CodePipelineCommandBuilder {
  /**
   * pipeline一覧commandを生成します。
   *
   * @param input pipeline一覧入力
   * @returns 固定AWS CLI command
   */
  public listPipelines(input: ListPipelinesInput): RemoteCommand {
    return this.#build("list-pipelines", input.region, { "max-results": input.limit, "next-token": input.nextToken });
  }

  /**
   * pipeline state参照commandを生成します。
   *
   * @param input pipeline state入力
   * @returns 固定AWS CLI command
   */
  public getPipelineState(input: GetPipelineStateInput): RemoteCommand {
    return this.#build("get-pipeline-state", input.region, { name: input.pipeline });
  }

  /**
   * pipeline execution一覧commandを生成します。
   *
   * @param input pipeline execution一覧入力
   * @returns 固定AWS CLI command
   */
  public listPipelineExecutions(input: ListPipelineExecutionsInput): RemoteCommand {
    return this.#build("list-pipeline-executions", input.region, {
      "pipeline-name": input.pipeline,
      "max-results": input.mode === "latest" ? 1 : input.limit,
      "next-token": input.nextToken,
    });
  }

  /**
   * pipeline execution詳細commandを生成します。
   *
   * @param input pipeline execution詳細入力
   * @returns 固定AWS CLI command
   */
  public getPipelineExecution(input: GetPipelineExecutionInput): RemoteCommand {
    return this.#build("get-pipeline-execution", input.region, {
      "pipeline-name": input.pipeline,
      "pipeline-execution-id": input.executionId,
    });
  }

  /**
   * action execution一覧commandを生成します。
   *
   * @param input action execution一覧入力
   * @returns 固定AWS CLI command
   */
  public listActionExecutions(input: ListActionExecutionsInput): RemoteCommand {
    return this.#build("list-action-executions", input.region, {
      "pipeline-name": input.pipeline,
      filter: input.executionId === undefined ? undefined : { pipelineExecutionId: input.executionId },
      "max-results": input.limit,
      "next-token": input.nextToken,
    });
  }

  /**
   * AWS共通policyをCodePipeline operationへ適用します。
   *
   * @param operation API operation
   * @param region AWS region
   * @param parameters operation parameter
   * @returns 固定AWS CLI command
   */
  #build(operation: string, region: string, parameters: Parameters<typeof buildAwsCommand>[0]["parameters"]): RemoteCommand {
    return buildAwsCommand({ service: "codepipeline", operation, region, parameters });
  }
}

/**
 * CodePipeline参照operationを実行し、診断に必要なfieldだけを返します。
 */
export class CodePipelineService {
  readonly #runner: RemoteCommandRunner;
  readonly #builder: CodePipelineCommandBuilder;

  /**
   * CodePipeline実行依存を固定します。
   *
   * @param runner bounded command runner
   * @param builder bounded command builder
   */
  public constructor(runner: RemoteCommandRunner, builder: CodePipelineCommandBuilder) {
    this.#runner = runner;
    this.#builder = builder;
  }

  /**
   * pipeline一覧を参照します。
   *
   * @param input pipeline一覧入力
   * @returns allow-field適用済み一覧
   */
  public async listPipelines(input: ListPipelinesInput): Promise<{ pipelines: unknown[]; nextToken?: string }> {
    const raw = z.object({ pipelines: z.array(z.unknown()).optional(), nextToken: z.string().optional() }).passthrough()
      .parse(await executeAwsJson(this.#runner, this.#builder.listPipelines(input)));
    return optionalToken({ pipelines: (raw.pipelines ?? []).slice(0, input.limit).map((item) => pipelineSchema.parse(item)) }, raw.nextToken);
  }

  /**
   * stage/action stateを参照します。
   *
   * @param input pipeline state入力
   * @returns allow-field適用済みstate
   */
  public async getPipelineState(input: GetPipelineStateInput): Promise<object> {
    return z.object({ pipelineName: z.string().optional(), pipelineVersion: z.number().optional(), stageStates: z.array(stageStateSchema).max(100).optional() }).strip()
      .parse(await executeAwsJson(this.#runner, this.#builder.getPipelineState(input)));
  }

  /**
   * pipeline execution一覧をmodeで絞り込みます。
   *
   * @param input pipeline execution一覧入力
   * @returns allow-field適用済み一覧
   */
  public async listPipelineExecutions(input: ListPipelineExecutionsInput): Promise<{ pipelineExecutionSummaries: unknown[]; nextToken?: string }> {
    const raw = z.object({ pipelineExecutionSummaries: z.array(z.unknown()).optional(), nextToken: z.string().optional() }).passthrough()
      .parse(await executeAwsJson(this.#runner, this.#builder.listPipelineExecutions(input)));
    const summaries = (raw.pipelineExecutionSummaries ?? []).map((item) => pipelineExecutionSummarySchema.parse(item));
    const filtered = input.mode === "failed" ? summaries.filter((item) => item.status === "Failed") : summaries;
    return optionalToken({ pipelineExecutionSummaries: filtered.slice(0, input.mode === "latest" ? 1 : input.limit) }, raw.nextToken);
  }

  /**
   * pipeline execution詳細を参照します。
   *
   * @param input pipeline execution詳細入力
   * @returns allow-field適用済み詳細
   */
  public async getPipelineExecution(input: GetPipelineExecutionInput): Promise<object> {
    const raw = z.object({ pipelineExecution: z.unknown() }).passthrough()
      .parse(await executeAwsJson(this.#runner, this.#builder.getPipelineExecution(input)));
    const execution = z.object({
      pipelineName: z.string().optional(),
      pipelineVersion: z.number().optional(),
      pipelineExecutionId: z.string().optional(),
      status: z.string().optional(),
      statusSummary: z.string().optional(),
      artifactRevisions: z.array(z.object({ name: z.string().optional(), revisionId: z.string().optional(), revisionSummary: z.string().optional() }).strip()).max(100).optional(),
    }).strip().parse(raw.pipelineExecution);
    return { pipelineExecution: execution };
  }

  /**
   * action execution一覧を参照します。
   *
   * @param input action execution一覧入力
   * @returns allow-field適用済み一覧
   */
  public async listActionExecutions(input: ListActionExecutionsInput): Promise<{ actionExecutionDetails: unknown[]; nextToken?: string }> {
    const raw = z.object({ actionExecutionDetails: z.array(z.unknown()).optional(), nextToken: z.string().optional() }).passthrough()
      .parse(await executeAwsJson(this.#runner, this.#builder.listActionExecutions(input)));
    return optionalToken({ actionExecutionDetails: (raw.actionExecutionDetails ?? []).slice(0, input.limit).map((item) => actionExecutionSchema.parse(item)) }, raw.nextToken);
  }
}

/** pagination tokenを存在時だけ返却します。 */
function optionalToken<T extends object>(result: T, nextToken: string | undefined): T & { nextToken?: string } {
  return nextToken === undefined ? result : { ...result, nextToken };
}