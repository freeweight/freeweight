import { defineTool } from "../tool.js";
import { CHAIN_PROP, TOKEN_PROP } from "../util/args.js";

export const officialCa = defineTool({
  name: "official_ca",
  title: "official_ca",
  description: "Not implemented yet.",
  inputSchema: { type: "object", properties: { chain: CHAIN_PROP, token: TOKEN_PROP }, additionalProperties: false },
  run: async () => ({ ok: false, summary: "official_ca is not implemented yet", data: {} }),
});
