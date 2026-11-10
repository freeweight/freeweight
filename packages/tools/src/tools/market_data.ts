import { defineTool } from "../tool.js";
import { CHAIN_PROP, TOKEN_PROP } from "../util/args.js";

export const marketData = defineTool({
  name: "market_data",
  title: "market_data",
  description: "Not implemented yet.",
  inputSchema: { type: "object", properties: { chain: CHAIN_PROP, token: TOKEN_PROP }, additionalProperties: false },
  run: async () => ({ ok: false, summary: "market_data is not implemented yet", data: {} }),
});
