import { compileLanguage } from "#/compiler/language.ts";
import { languages } from "#/languages/mod.ts";
import { buildModule } from "#/tools/module.ts";
import { fromFileUrl, toFileUrl } from "jsr:@std/path@^1.0.6";
import { copyEntrypoints, copyRuntime, installBuild } from "./package.ts";
import { run } from "../compat/avril-std.ts";
import upstream from "../upstream.json" with { type: "json" };
import release from "../release.json" with { type: "json" };

const root = new URL("../", import.meta.url);
const cache = new URL(".cache/", root);
const tools: Record<string, string> = {};
for (const command of ["wat2wasm", "wasm-opt", "wasm-validate"]) {
  const output = await run(command, ["--version"]);
  tools[command] = new TextDecoder().decode(output.stdout).trim();
}
const toolchain = new Uint8Array(
  await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ upstream, tools })),
  ),
);
const key = Array.from(toolchain, (byte) => byte.toString(16).padStart(2, "0"))
  .join("");
Deno.env.set(
  "GLISTEN_BUILD_CACHE",
  fromFileUrl(new URL(`modules/${key}/`, cache)),
);
const temporary = await Deno.makeTempDir({
  dir: fromFileUrl(cache),
  prefix: "dist-",
});
const staged = toFileUrl(temporary + "/");
const destination = new URL("dist/", staged);
const entries: Record<
  string,
  { file: string; sha256: string; aliases: string[]; embeds: string[] }
> = {};
const aliases: Record<string, string> = Object.create(null);
const catalog = [];

try {
  await copyRuntime(new URL("upstream/", cache), destination);
  await Deno.mkdir(new URL("modules/", destination));
  for (const name of Object.keys(languages).sort()) {
    const { default: source } = await languages[name]();
    const compiled = compileLanguage(source);
    const { manifest } = compiled;
    if (manifest.language !== name) {
      throw new Error(`Language name mismatch: ${name}`);
    }
    const bytes = new Uint8Array(await buildModule(compiled));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const file = `${name}.wasm`;
    await Deno.writeFile(new URL(`modules/${file}`, destination), bytes);
    entries[name] = {
      file,
      sha256: hash,
      aliases: manifest.aliases,
      embeds: manifest.embeds,
    };
    catalog.push({
      language: name,
      aliases: manifest.aliases,
      extensions: manifest.extensions ?? [],
      filenames: manifest.filenames ?? [],
    });
    for (const alias of [name, ...manifest.aliases]) {
      aliases[alias.toLowerCase()] ??= name;
    }
  }
  await Deno.writeTextFile(
    new URL("_generated/languages.json", destination),
    JSON.stringify(catalog) + "\n",
  );
  await Deno.writeTextFile(
    new URL("manifest.json", destination),
    JSON.stringify({ upstream, languages: entries, aliases }, null, 2) + "\n",
  );
  await Deno.writeTextFile(
    new URL("build.json", destination),
    JSON.stringify({ upstream, tools }, null, 2) + "\n",
  );
  await copyEntrypoints(root, staged);
  await Deno.writeTextFile(
    new URL("deno.json", staged),
    JSON.stringify(release, null, 2) + "\n",
  );
  await installBuild(staged, new URL("build/", root));
  console.log(
    `Built ${
      Object.keys(entries).length
    } glisten grammars and their typed runtime`,
  );
} finally {
  await Deno.remove(temporary, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}
