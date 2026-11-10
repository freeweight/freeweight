import { defineTool } from "../tool.js";
import { CHAIN_PROP, TOKEN_PROP } from "../util/args.js";

export const chainRead = defineTool({
  name: "chain_read",
  title: "chain_read",
  description: "Not implemented yet.",
  inputSchema: { type: "object", properties: { chain: CHAIN_PROP, token: TOKEN_PROP }, additionalProperties: false },
  run: async () => ({ ok: false, summary: "chain_read is not implemented yet", data: {} }),
});
