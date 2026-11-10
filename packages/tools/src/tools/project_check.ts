import { defineTool } from "../tool.js";
import { CHAIN_PROP, TOKEN_PROP } from "../util/args.js";

export const projectCheck = defineTool({
  name: "project_check",
  title: "project_check",
  description: "Not implemented yet.",
  inputSchema: { type: "object", properties: { chain: CHAIN_PROP, token: TOKEN_PROP }, additionalProperties: false },
  run: async () => ({ ok: false, summary: "project_check is not implemented yet", data: {} }),
});
