import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/size.mjs", import.meta.url));

/** Runs the size check on a small build made of these chunks and returns the chunks it lists as text. */
function textChunks(chunks: Record<string, string>): string[] {
  const dist = mkdtempSync(join(tmpdir(), "fw-size-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), '<script type="module" src="/assets/index-a.js"></script>');
  writeFileSync(join(dist, "assets", "index-a.js"), "export{};");
  for (const [name, src] of Object.entries(chunks)) writeFileSync(join(dist, "assets", name), src);
  const out = spawnSync(process.execPath, [SCRIPT, dist], { encoding: "utf8" });
  expect(out.status).toBe(0);
  const section = out.stdout.split("Pages of text, outside the budget")[1]?.split("Budget")[0] ?? "";
  return Object.keys(chunks).filter((name) => section.includes(name));
}

describe("the size check", () => {
  it("counts a chunk that holds one string as text", () => {
    const chunks = {
      "a.js": "const e=`# Page\\n\\${x} and a \\` tick, $5 a day`;export{e as default};",
      "b.js": 'const n="say \\"hi\\"";export{n as default}',
      "c.js": "const t='it\\'s';export{t as default};\n",
      "big.js": `const e=\`${"a line of text\\n".repeat(20_000)}\`;export{e as default};`,
    };
    expect(textChunks(chunks).sort()).toEqual(Object.keys(chunks).sort());
  });
  it("counts code between two strings as code", () => {
    expect(
      textChunks({
        "code.js": 'const e="a";function f(){return 1}const t="b";export{e as default}',
        "mixed.js": "const e=`a`+f();const f=()=>`b`;export{e as default}",
        "template.js": "const e=`costs ${f()} a $ day`;export{e as default}",
      }),
    ).toEqual([]);
  });
});
