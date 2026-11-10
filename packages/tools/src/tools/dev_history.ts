import { defineTool } from "../tool.js";
import { CHAIN_PROP, TOKEN_PROP } from "../util/args.js";

export const devHistory = defineTool({
  name: "dev_history",
  title: "dev_history",
  description: "Not implemented yet.",
  inputSchema: { type: "object", properties: { chain: CHAIN_PROP, token: TOKEN_PROP }, additionalProperties: false },
  run: async () => ({ ok: false, summary: "dev_history is not implemented yet", data: {} }),
});
