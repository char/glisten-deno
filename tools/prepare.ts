import upstream from "../upstream.json" with { type: "json" };
import { checkout } from "./checkout.ts";
import { run } from "../compat/avril-std.ts";
import { exists } from "../compat/avril-fs.ts";
import { fromFileUrl } from "jsr:@std/path@^1.0.6";

for (const command of ["git", "wat2wasm", "wasm-validate", "wasm-opt"]) {
  try {
    await run(command, ["--version"], { stdout: "null", stderr: "inherit" });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Missing ${command} on PATH; install Git, WABT, and Binaryen`,
      );
    }
    throw error;
  }
}
await Deno.mkdir(new URL("../.cache/", import.meta.url), { recursive: true });
await checkout(upstream, new URL("../.cache/upstream/", import.meta.url));

const output = new URL("../build/", import.meta.url);
if (!await exists(fromFileUrl(new URL(".git", output)))) {
  await run("git", [
    "init",
    "--quiet",
    "--initial-branch=main",
    fromFileUrl(output),
  ]);
}
