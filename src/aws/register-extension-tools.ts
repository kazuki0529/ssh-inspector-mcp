import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { RemoteCommandRunner } from "../execution/executor.js";
import { executeTool } from "../tools/tool-result.js";
import { buildAwsCommand, type AwsParameterValue } from "./build-argv.js";
import { executeAwsJson } from "./execute.js";
import type { AwsToolSpec } from "./spec-schema.js";

/**
 * 検証済み宣言specからstrict input schemaとAWS handlerを登録します。
 *
 * @param server 登録先MCP server
 * @param runner bounded command runner
 * @param specs 起動時に検証済みのimmutable spec
 */
export function registerAwsExtensionTools(
  server: McpServer,
  runner: RemoteCommandRunner,
  specs: readonly AwsToolSpec[],
): void {
  for (const spec of specs) {
    const inputSchema = createInputSchema(spec);
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema },
      async (input) => executeTool(async () => {
        const parameters: Record<string, AwsParameterValue | undefined> = { ...spec.fixedArgs };
        for (const parameter of spec.parameters) {
          parameters[parameter.cliName] = input[parameter.name] as AwsParameterValue | undefined;
        }
        const command = buildAwsCommand({
          service: spec.service,
          operation: spec.operation,
          region: spec.region,
          parameters,
        });
        const result = await executeAwsJson(runner, command, {
          timeoutMs: spec.timeoutMs,
          maxOutputBytes: spec.maxOutputBytes,
        });

        return { result };
      }),
    );
  }
}

/**
 * parameter宣言をZod v4 schemaへ変換します。
 *
 * @param spec 検証済みtool spec
 * @returns unknown keyを拒否するinput schema
 */
function createInputSchema(spec: AwsToolSpec): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};

  for (const parameter of spec.parameters) {
    let schema: z.ZodType;
    switch (parameter.type) {
      case "string": {
        let stringSchema = z.string().min(parameter.minLength).max(parameter.maxLength);
        if (parameter.enum) {
          const allowed = new Set(parameter.enum);
          stringSchema = stringSchema.refine((value) => allowed.has(value), "許可値ではありません");
        }
        schema = stringSchema;
        break;
      }
      case "integer":
        schema = z.number().int().min(parameter.minimum).max(parameter.maximum);
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "stringArray":
        schema = z.array(z.string().max(parameter.itemMaxLength)).min(parameter.minItems).max(parameter.maxItems);
        break;
      case "jsonObject":
        schema = z.record(z.string().max(255), z.unknown()).refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= parameter.maxBytes);
        break;
    }
    shape[parameter.name] = parameter.required ? schema : schema.optional();
  }

  return z.object(shape).strict();
}