import { z } from "zod";

import type { RemoteCommandRunner } from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";
import { buildAwsCommand } from "./build-argv.js";
import { executeAwsJson } from "./execute.js";

const projectNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/);
const buildIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,254}:[0-9a-fA-F-]{36}$/);
const tokenSchema = z.string().min(1).max(4096).optional();
const limitSchema = z.number().int().min(1).max(100).default(100);

/** project一覧入力schemaです。 */
export const listProjectsInputSchema = z.object({
  region: z.string(),
  sortBy: z.enum(["NAME", "CREATED_TIME", "LAST_MODIFIED_TIME"]).default("NAME"),
  sortOrder: z.enum(["ASCENDING", "DESCENDING"]).default("ASCENDING"),
  limit: limitSchema,
  nextToken: tokenSchema,
}).strict();

/** project一括取得入力schemaです。 */
export const batchGetProjectsInputSchema = z.object({
  region: z.string(),
  projects: z.array(projectNameSchema).min(1).max(100),
}).strict();

/** project別build一覧入力schemaです。 */
export const listBuildsForProjectInputSchema = z.object({
  region: z.string(),
  project: projectNameSchema,
  sortOrder: z.enum(["ASCENDING", "DESCENDING"]).default("DESCENDING"),
  limit: limitSchema,
  nextToken: tokenSchema,
}).strict();

/** build一括取得入力schemaです。 */
export const batchGetBuildsInputSchema = z.object({
  region: z.string(),
  buildIds: z.array(buildIdSchema).min(1).max(100),
}).strict();

/** project一覧入力型です。 */
export type ListProjectsInput = z.infer<typeof listProjectsInputSchema>;
/** project一括取得入力型です。 */
export type BatchGetProjectsInput = z.infer<typeof batchGetProjectsInputSchema>;
/** project別build一覧入力型です。 */
export type ListBuildsForProjectInput = z.infer<typeof listBuildsForProjectInputSchema>;
/** build一括取得入力型です。 */
export type BatchGetBuildsInput = z.infer<typeof batchGetBuildsInputSchema>;

const environmentVariableSchema = z.object({ name: z.string().optional(), type: z.string().optional() }).strip();
const environmentSchema = z.object({
  type: z.string().optional(),
  image: z.string().optional(),
  computeType: z.string().optional(),
  environmentType: z.string().optional(),
  privilegedMode: z.boolean().optional(),
  imagePullCredentialsType: z.string().optional(),
  environmentVariables: z.array(environmentVariableSchema).max(100).optional(),
}).strip();
const sourceSchema = z.object({ type: z.string().optional(), sourceIdentifier: z.string().optional() }).strip();
const cloudWatchLogsSchema = z.object({
  status: z.string().optional(),
  groupName: z.string().optional(),
  streamName: z.string().optional(),
}).strip();
const logsConfigSchema = z.object({
  cloudWatchLogs: cloudWatchLogsSchema.optional(),
  s3Logs: z.object({ status: z.string().optional() }).strip().optional(),
}).strip();
const projectSchema = z.object({
  name: z.string().optional(),
  arn: z.string().optional(),
  description: z.string().optional(),
  source: sourceSchema.optional(),
  secondarySources: z.array(sourceSchema).max(100).optional(),
  environment: environmentSchema.optional(),
  serviceRole: z.string().optional(),
  timeoutInMinutes: z.number().optional(),
  queuedTimeoutInMinutes: z.number().optional(),
  logsConfig: logsConfigSchema.optional(),
  created: z.string().optional(),
  lastModified: z.string().optional(),
}).strip();
const phaseSchema = z.object({
  phaseType: z.string().optional(),
  phaseStatus: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  durationInSeconds: z.number().optional(),
  contexts: z.array(z.object({ statusCode: z.string().optional(), message: z.string().optional() }).strip()).max(100).optional(),
}).strip();
const buildSchema = z.object({
  id: z.string().optional(),
  arn: z.string().optional(),
  buildNumber: z.number().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  currentPhase: z.string().optional(),
  buildStatus: z.string().optional(),
  sourceVersion: z.string().optional(),
  resolvedSourceVersion: z.string().optional(),
  projectName: z.string().optional(),
  phases: z.array(phaseSchema).max(100).optional(),
  source: sourceSchema.optional(),
  secondarySources: z.array(sourceSchema).max(100).optional(),
  environment: environmentSchema.optional(),
  logs: z.object({ groupName: z.string().optional(), streamName: z.string().optional() }).strip().optional(),
  initiator: z.string().optional(),
  buildComplete: z.boolean().optional(),
}).strip();

/**
 * CodeBuild入力を固定AWS CLI commandへ変換します。
 */
export class CodeBuildCommandBuilder {
  /**
   * project一覧commandを生成します。
   *
   * @param input project一覧入力
   * @returns 固定AWS CLI command
   */
  public listProjects(input: ListProjectsInput): RemoteCommand {
    return this.#build("list-projects", input.region, {
      "sort-by": input.sortBy,
      "sort-order": input.sortOrder,
      "next-token": input.nextToken,
    });
  }

  /**
   * project一括取得commandを生成します。
   *
   * @param input project一括取得入力
   * @returns 固定AWS CLI command
   */
  public batchGetProjects(input: BatchGetProjectsInput): RemoteCommand {
    return this.#build("batch-get-projects", input.region, { names: input.projects });
  }

  /**
   * project別build一覧commandを生成します。
   *
   * @param input project別build一覧入力
   * @returns 固定AWS CLI command
   */
  public listBuildsForProject(input: ListBuildsForProjectInput): RemoteCommand {
    return this.#build("list-builds-for-project", input.region, {
      "project-name": input.project,
      "sort-order": input.sortOrder,
      "next-token": input.nextToken,
    });
  }

  /**
   * build一括取得commandを生成します。
   *
   * @param input build一括取得入力
   * @returns 固定AWS CLI command
   */
  public batchGetBuilds(input: BatchGetBuildsInput): RemoteCommand {
    return this.#build("batch-get-builds", input.region, { ids: input.buildIds });
  }

  /**
   * AWS共通policyをCodeBuild operationへ適用します。
   *
   * @param operation API operation
   * @param region AWS region
   * @param parameters operation parameter
   * @returns 固定AWS CLI command
   */
  #build(operation: string, region: string, parameters: Parameters<typeof buildAwsCommand>[0]["parameters"]): RemoteCommand {
    return buildAwsCommand({ service: "codebuild", operation, region, parameters });
  }
}

/**
 * CodeBuild参照operationを実行し、診断に必要なfieldだけを返します。
 */
export class CodeBuildService {
  readonly #runner: RemoteCommandRunner;
  readonly #builder: CodeBuildCommandBuilder;

  /**
   * CodeBuild実行依存を固定します。
   *
   * @param runner bounded command runner
   * @param builder bounded command builder
   */
  public constructor(runner: RemoteCommandRunner, builder: CodeBuildCommandBuilder) {
    this.#runner = runner;
    this.#builder = builder;
  }

  /**
   * project名をbounded一覧します。
   *
   * @param input project一覧入力
   * @returns project名とpagination token
   */
  public async listProjects(input: ListProjectsInput): Promise<{ projects: string[]; nextToken?: string }> {
    const raw = z.object({ projects: z.array(z.string()).max(100).optional(), nextToken: z.string().optional() }).passthrough()
      .parse(await executeAwsJson(this.#runner, this.#builder.listProjects(input)));
    return optionalToken({ projects: (raw.projects ?? []).slice(0, input.limit) }, raw.nextToken);
  }

  /**
   * project設定から秘密fieldを除外して返します。
   *
   * @param input project一括取得入力
   * @returns allow-field適用済みproject
   */
  public async batchGetProjects(input: BatchGetProjectsInput): Promise<{ projects: unknown[]; projectsNotFound: string[] }> {
    const raw = z.object({ projects: z.array(z.unknown()).optional(), projectsNotFound: z.array(z.string()).optional() }).passthrough()
      .parse(await executeAwsJson(this.#runner, this.#builder.batchGetProjects(input)));
    return {
      projects: (raw.projects ?? []).slice(0, input.projects.length).map((project) => projectSchema.parse(project)),
      projectsNotFound: raw.projectsNotFound ?? [],
    };
  }

  /**
   * projectのbuild IDをbounded一覧します。
   *
   * @param input project別build一覧入力
   * @returns build IDとpagination token
   */
  public async listBuildsForProject(input: ListBuildsForProjectInput): Promise<{ ids: string[]; nextToken?: string }> {
    const raw = z.object({ ids: z.array(z.string()).max(100).optional(), nextToken: z.string().optional() }).passthrough()
      .parse(await executeAwsJson(this.#runner, this.#builder.listBuildsForProject(input)));
    return optionalToken({ ids: (raw.ids ?? []).slice(0, input.limit) }, raw.nextToken);
  }

  /**
   * buildからphaseとCloudWatch Logs識別子だけを含む診断結果を返します。
   *
   * @param input build一括取得入力
   * @returns allow-field適用済みbuild
   */
  public async batchGetBuilds(input: BatchGetBuildsInput): Promise<{ builds: unknown[]; buildsNotFound: string[] }> {
    const raw = z.object({ builds: z.array(z.unknown()).optional(), buildsNotFound: z.array(z.string()).optional() }).passthrough()
      .parse(await executeAwsJson(this.#runner, this.#builder.batchGetBuilds(input)));
    return {
      builds: (raw.builds ?? []).slice(0, input.buildIds.length).map((build) => buildSchema.parse(build)),
      buildsNotFound: raw.buildsNotFound ?? [],
    };
  }
}

/** pagination tokenを存在時だけ返却します。 */
function optionalToken<T extends object>(result: T, nextToken: string | undefined): T & { nextToken?: string } {
  return nextToken === undefined ? result : { ...result, nextToken };
}