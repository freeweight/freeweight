import { defineTool } from "../tool.js";
import { addr, chainArg, CHAIN_PROP, int, short, str } from "../util/args.js";
import { soft } from "../util/http.js";
import { rpc } from "../util/rpc.js";
import { EIP1967_IMPL, minimalProxyTarget, slotAddress } from "../util/bytecode.js";
import { sourcify } from "../sources/sourcify.js";
import { explorerSource } from "../sources/explorer.js";

const DEFAULT_CAP = 40_000;

export const contractSource = defineTool({
  name: "contract_source",
  title: "Contract source",
  description:
    "Verified source code and ABI of a contract from Sourcify (then a Blockscout explorer where reachable). Returns the file list with sizes and the " +
    "main contract's source trimmed to a size cap; pass file to read one file. Follows EIP-1967/1167 proxies to the implementation when the proxy itself is a stub.",
  inputSchema: {
    type: "object",
    properties: {
      chain: CHAIN_PROP,
      address: { type: "string", description: "Contract address." },
      token: { type: "string", description: "Alias of address." },
      file: { type: "string", description: "Path of one source file to return (from the file list)." },
      max_chars: { type: "integer", minimum: 2000, maximum: 120000, description: `Source size cap (default ${DEFAULT_CAP}).` },
      include_abi: { type: "boolean", description: "Include the ABI (function/event signatures only). Default true." },
    },
    additionalProperties: false,
  },
  run: async (args, run) => {
    const chain = chainArg(args);
    const address = addr(args, args.address !== undefined ? "address" : "token")!;
    const file = str(args, "file", 400);
    const cap = int(args, "max_chars", DEFAULT_CAP, 2000, 120_000);
    const includeAbi = args.include_abi !== false;

    const lookup = async (a: string) => {
      const s = await soft(run, "sourcify", sourcify(run, chain, a, true));
      if (s) return { via: "sourcify", match: s.match, name: s.name, compiler: s.compiler, language: s.language, files: s.files, abi: s.abi };
      const e = await explorerSource(run, chain, a).catch(() => null);
      if (e && e.verified && e.files.length) return { via: "blockscout", match: "verified", name: e.name, compiler: e.compiler, language: e.language, files: e.files, abi: e.abi };
      return null;
    };

    let src = await lookup(address);
    let target = address;
    let impl: string | null = null;
    const code = await rpc<string>(run, chain, "eth_getCode", [address, "latest"], { ttl: 600 }).catch(() => null);
    if (code && code !== "0x") {
      impl = minimalProxyTarget(code) ?? slotAddress(await rpc<string>(run, chain, "eth_getStorageAt", [address, EIP1967_IMPL, "latest"], { ttl: 300 }).catch(() => null));
    }
    if (impl && (!src || (src.files.length <= 3 && /proxy/i.test(src.name ?? "")))) {
      const s2 = await lookup(impl);
      if (s2) {
        src = s2;
        target = impl;
      }
    }
    if (!src) {
      return {
        summary: `No verified source for ${short(address)} on ${chain.name}${impl ? ` (proxy → ${short(impl)}, also unverified)` : ""}. ${code === "0x" ? "The address has no code." : "Only bytecode is available (safety_check scans it)."}`,
        data: { chain: chain.key, chain_id: chain.id, address, verified: false, implementation: impl, code_bytes: code && code !== "0x" ? (code.length - 2) / 2 : 0 },
      };
    }

    const fileList = src.files.map((f) => ({ path: f.path, chars: f.content.length }));
    const isLib = (p: string) => /(^|\/)(node_modules|lib|@openzeppelin|@uniswap|solmate|forge-std)\//i.test(p);
    let chosen = file ? src.files.find((f) => f.path === file || f.path.endsWith("/" + file)) : undefined;
    if (!chosen) {
      const nameRe = src.name ? new RegExp(`(^|/)${src.name.replace(/[^A-Za-z0-9_]/g, "")}\\.(sol|vy)$`) : null;
      chosen = (nameRe && src.files.find((f) => nameRe.test(f.path))) || src.files.filter((f) => !isLib(f.path)).sort((a, b) => b.content.length - a.content.length)[0] || src.files[0];
    }
    const content = chosen?.content ?? "";
    const truncated = content.length > cap;
    const abiSigs = includeAbi && src.abi
      ? (src.abi as { type?: string; name?: string; inputs?: { type: string; name?: string }[]; stateMutability?: string }[])
          .filter((x) => x.type === "function" || x.type === "event")
          .slice(0, 150)
          .map((x) => `${x.type} ${x.name}(${(x.inputs ?? []).map((i) => i.type).join(",")})${x.stateMutability && x.stateMutability !== "nonpayable" ? " " + x.stateMutability : ""}`)
      : null;
    if (file && !src.files.some((f) => f.path === chosen?.path)) run.note(`file ${file} not found; returned the main file`);
    return {
      summary: `${src.name ?? "Contract"} at ${short(target)}${target !== address ? ` (implementation behind proxy ${short(address)})` : ""} is verified on ${src.via} (${src.match ?? "match"}), ${src.compiler ?? "compiler ?"}; ${src.files.length} file(s); returning ${chosen?.path ?? "?"}${truncated ? ` trimmed to ${cap} chars` : ""}.`,
      data: {
        chain: chain.key,
        chain_id: chain.id,
        address,
        source_address: target,
        implementation: impl,
        verified: true,
        via: src.via,
        match: src.match,
        name: src.name,
        compiler: src.compiler,
        language: src.language,
        files: fileList.slice(0, 200),
        file: chosen?.path ?? null,
        source: truncated ? content.slice(0, cap) : content,
        truncated,
        abi_signatures: abiSigs,
      },
    };
  },
});
