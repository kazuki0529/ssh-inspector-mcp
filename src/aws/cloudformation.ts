import { z } from "zod";

import type { RemoteCommandRunner } from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";
import { buildAwsCommand } from "./build-argv.js";
import { executeAwsJson } from "./execute.js";

const tokenSchema = z.string().min(1).max(4096).optional();
const stackIdentifierSchema = z.string().min(1).max(2048);
const logicalResourceIdSchema = z.string().regex(/^[A-Za-z0-9]{1,255}$/);
const resourceStatusSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const timestampSchema = z.iso.datetime({ offset: true }).optional();

/** CloudFormation stack一覧入力schemaです。 */
export const describeStacksInputSchema = z.object({
  region: z.string(),
  stackName: stackIdentifierSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  nextToken: tokenSchema,
}).strict();

/** CloudFormation stack event検索入力schemaです。 */
export const describeStackEventsInputSchema = z.object({
  region: z.string(),
  stackName: stackIdentifierSchema,
  resourceStatus: resourceStatusSchema.optional(),
  logicalResourceId: logicalResourceIdSchema.optional(),
  startTime: timestampSchema,
  endTime: timestampSchema,
  limit: z.number().int().min(1).max(100).default(50),
  nextToken: tokenSchema,
}).strict().refine(
  (input) => input.startTime === undefined || input.endTime === undefined || new Date(input.startTime).getTime() < new Date(input.endTime).getTime(),
  { path: ["endTime"], message: "endTimeはstartTimeより後である必要があります" },
);

/** CloudFormation stack resource一覧入力schemaです。 */
export const listStackResourcesInputSchema = z.object({
  region: z.string(),
  stackName: stackIdentifierSchema,
  limit: z.number().int().min(1).max(100).default(50),
  nextToken: tokenSchema,
}).strict();

/** CloudFormation単一stack resource入力schemaです。 */
export const describeStackResourceInputSchema = z.object({
  region: z.string(),
  stackName: stackIdentifierSchema,
  logicalResourceId: logicalResourceIdSchema,
}).strict();

/** stack一覧入力型です。 */
export type DescribeStacksInput = z.infer<typeof describeStacksInputSchema>;
/** stack event検索入力型です。 */
export type DescribeStackEventsInput = z.infer<typeof describeStackEventsInputSchema>;
/** stack resource一覧入力型です。 */
export type ListStackResourcesInput = z.infer<typeof listStackResourcesInputSchema>;
/** 単一stack resource入力型です。 */
export type DescribeStackResourceInput = z.infer<typeof describeStackResourceInputSchema>;

const stackSchema = z.object({
  StackId: z.string().optional(),
  StackName: z.string(),
  StackStatus: z.string(),
  StackStatusReason: z.string().optional(),
  CreationTime: z.string().optional(),
  LastUpdatedTime: z.string().optional(),
  DeletionTime: z.string().optional(),
  EnableTerminationProtection: z.boolean().optional(),
  DriftInformation: z.object({ StackDriftStatus: z.string(), LastCheckTimestamp: z.string().optional() }).passthrough().optional(),
}).passthrough();

const stackEventSchema = z.object({
  EventId: z.string(),
  StackId: z.string().optional(),
  StackName: z.string().optional(),
  LogicalResourceId: z.string().optional(),
  PhysicalResourceId: z.string().optional(),
  ResourceType: z.string().optional(),
  Timestamp: z.string(),
  ResourceStatus: z.string().optional(),
  ResourceStatusReason: z.string().optional(),
  ClientRequestToken: z.string().optional(),
}).passthrough();

const stackResourceSchema = z.object({
  LogicalResourceId: z.string(),
  PhysicalResourceId: z.string().optional(),
  ResourceType: z.string(),
  ResourceStatus: z.string(),
  ResourceStatusReason: z.string().optional(),
  LastUpdatedTimestamp: z.string().optional(),
  DriftInformation: z.object({ StackResourceDriftStatus: z.string(), LastCheckTimestamp: z.string().optional() }).passthrough().optional(),
}).passthrough();

/** CloudFormation入力を固定AWS CLI commandへ変換します。 */
export class CloudFormationCommandBuilder {
  /**
   * stack一覧参照commandを生成します。
   *
   * @param input stack一覧入力
   * @returns 固定command
   */
  public describeStacks(input: DescribeStacksInput): RemoteCommand {
    return this.#build("describe-stacks", input.region, { "stack-name": input.stackName, "max-items": input.limit, "next-token": input.nextToken });
  }

  /**
   * stack event参照commandを生成します。
   *
   * @param input stack event入力
   * @returns 固定command
   */
  public describeStackEvents(input: DescribeStackEventsInput): RemoteCommand {
    return this.#build("describe-stack-events", input.region, { "stack-name": input.stackName, "max-items": input.limit, "next-token": input.nextToken });
  }

  /**
   * stack resource一覧commandを生成します。
   *
   * @param input resource一覧入力
   * @returns 固定command
   */
  public listStackResources(input: ListStackResourcesInput): RemoteCommand {
    return this.#build("list-stack-resources", input.region, { "stack-name": input.stackName, "max-items": input.limit, "next-token": input.nextToken });
  }

  /**
   * 単一stack resource参照commandを生成します。
   *
   * @param input 単一resource入力
   * @returns 固定command
   */
  public describeStackResource(input: DescribeStackResourceInput): RemoteCommand {
    return this.#build("describe-stack-resource", input.region, { "stack-name": input.stackName, "logical-resource-id": input.logicalResourceId });
  }

  /**
   * CloudFormation operationへAWS共通policyを適用します。
   *
   * @param operation API operation
   * @param region AWS region
   * @param parameters operation parameter
   * @returns 固定command
   */
  #build(operation: string, region: string, parameters: Parameters<typeof buildAwsCommand>[0]["parameters"]): RemoteCommand {
    return buildAwsCommand({ service: "cloudformation", operation, region, parameters });
  }
}

/** CloudFormation診断結果を秘密fieldを除いた形へ整形します。 */
export class CloudFormationService {
  readonly #runner: RemoteCommandRunner;
  readonly #builder: CloudFormationCommandBuilder;

  /**
   * bounded runnerとcommand builderを固定します。
   *
   * @param runner bounded runner
   * @param builder command builder
   */
  public constructor(runner: RemoteCommandRunner, builder: CloudFormationCommandBuilder) {
    this.#runner = runner;
    this.#builder = builder;
  }

  /**
   * 秘密fieldを除いたstack一覧を返します。
   *
   * @param input stack一覧入力
   * @returns allow-field stack一覧
   */
  public async describeStacks(input: DescribeStacksInput): Promise<{ result: unknown }> {
    const raw = await executeAwsJson(this.#runner, this.#builder.describeStacks(input));
    const parsed = z.object({ Stacks: z.array(stackSchema).default([]), NextToken: tokenSchema }).passthrough().parse(raw);
    return { result: { Stacks: parsed.Stacks.slice(0, input.limit).map(shapeStack), NextToken: parsed.NextToken } };
  }

  /**
   * stack eventsを診断条件で絞り込んで返します。
   *
   * @param input stack event入力
   * @returns filtered event一覧
   */
  public async describeStackEvents(input: DescribeStackEventsInput): Promise<{ result: unknown }> {
    const raw = await executeAwsJson(this.#runner, this.#builder.describeStackEvents(input));
    const parsed = z.object({ StackEvents: z.array(stackEventSchema).default([]), NextToken: tokenSchema }).passthrough().parse(raw);
    const start = input.startTime === undefined ? undefined : new Date(input.startTime).getTime();
    const end = input.endTime === undefined ? undefined : new Date(input.endTime).getTime();
    const events = parsed.StackEvents.filter((event) => {
      const timestamp = new Date(event.Timestamp).getTime();
      return (input.resourceStatus === undefined || event.ResourceStatus === input.resourceStatus)
        && (input.logicalResourceId === undefined || event.LogicalResourceId === input.logicalResourceId)
        && (start === undefined || timestamp >= start)
        && (end === undefined || timestamp <= end);
    });
    return { result: { StackEvents: events.slice(0, input.limit).map(shapeStackEvent), NextToken: parsed.NextToken } };
  }

  /**
   * 許可fieldだけのstack resource一覧を返します。
   *
   * @param input resource一覧入力
   * @returns allow-field resource一覧
   */
  public async listStackResources(input: ListStackResourcesInput): Promise<{ result: unknown }> {
    const raw = await executeAwsJson(this.#runner, this.#builder.listStackResources(input));
    const parsed = z.object({ StackResourceSummaries: z.array(stackResourceSchema).default([]), NextToken: tokenSchema }).passthrough().parse(raw);
    return { result: { StackResourceSummaries: parsed.StackResourceSummaries.slice(0, input.limit).map(shapeStackResource), NextToken: parsed.NextToken } };
  }

  /**
   * 許可fieldだけの単一stack resourceを返します。
   *
   * @param input 単一resource入力
   * @returns allow-field resource
   */
  public async describeStackResource(input: DescribeStackResourceInput): Promise<{ result: unknown }> {
    const raw = await executeAwsJson(this.#runner, this.#builder.describeStackResource(input));
    const parsed = z.object({ StackResourceDetail: stackResourceSchema }).passthrough().parse(raw);
    return { result: { StackResourceDetail: shapeStackResource(parsed.StackResourceDetail) } };
  }
}

function shapeStack(stack: z.infer<typeof stackSchema>): object {
  const { StackId, StackName, StackStatus, StackStatusReason, CreationTime, LastUpdatedTime, DeletionTime, EnableTerminationProtection, DriftInformation } = stack;
  return { StackId, StackName, StackStatus, StackStatusReason, CreationTime, LastUpdatedTime, DeletionTime, EnableTerminationProtection, DriftInformation };
}

function shapeStackEvent(event: z.infer<typeof stackEventSchema>): object {
  const { EventId, StackId, StackName, LogicalResourceId, PhysicalResourceId, ResourceType, Timestamp, ResourceStatus, ResourceStatusReason, ClientRequestToken } = event;
  return { EventId, StackId, StackName, LogicalResourceId, PhysicalResourceId, ResourceType, Timestamp, ResourceStatus, ResourceStatusReason, ClientRequestToken };
}

function shapeStackResource(resource: z.infer<typeof stackResourceSchema>): object {
  const { LogicalResourceId, PhysicalResourceId, ResourceType, ResourceStatus, ResourceStatusReason, LastUpdatedTimestamp, DriftInformation } = resource;
  return { LogicalResourceId, PhysicalResourceId, ResourceType, ResourceStatus, ResourceStatusReason, LastUpdatedTimestamp, DriftInformation };
}