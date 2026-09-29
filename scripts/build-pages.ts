import { mkdir, rm, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("dist/pages");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const build = await Bun.build({
  entrypoints: ["packages/ghostty-vt-js/demo/playground.ts"],
  outdir: output, target: "browser", minify: true,
});
if (!build.success) throw new AggregateError(build.logs, "Pages build failed");
const html = await Bun.file("packages/ghostty-vt-js/demo/playground.html").text();
await Bun.write(`${output}/index.html`, html.replace('./playground.ts', './playground.js'));
await copyFile("packages/ghostty-vt-js/wasm/ghostty-vt.wasm", `${output}/ghostty-vt.wasm`);
await copyFile("LICENSE", `${output}/LICENSE`);
await copyFile("THIRD_PARTY_NOTICES.md", `${output}/THIRD_PARTY_NOTICES.md`);
await Bun.write(`${output}/.nojekyll`, "");
console.log(`Built GitHub Pages playground in ${output}`);
