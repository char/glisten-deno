import { Highlighter as Host } from "./build/dist/host/mod.ts";
import data from "./build/dist/manifest.json" with { type: "json" };

export { languageFor } from "./filename.ts";
export {
  AbiError,
  Highlighter as Host,
  ResourceError,
} from "./build/dist/host/mod.ts";

export type Grammar = {
  readonly file: string;
  readonly sha256: string;
  readonly aliases: readonly string[];
  readonly embeds: readonly string[];
};

export const manifest: {
  readonly upstream: { readonly git: string; readonly rev: string };
  readonly languages: Readonly<Record<string, Grammar>>;
  readonly aliases: Readonly<Record<string, string>>;
} = data;

const aliases = new Map(Object.entries(manifest.aliases));
const grammars = new Map(Object.entries(manifest.languages));
const baseURL = new URL("./build/dist/modules/", import.meta.url);

export type GrammarLoader = (url: URL) => Promise<Uint8Array>;
type HostOptions = NonNullable<ConstructorParameters<typeof Host>[0]>;
export type Options = Omit<HostOptions, "loadLanguage"> & {
  load?: GrammarLoader;
  baseURL?: URL;
};

export function canonicalLanguage(language: string): string | null {
  return aliases.get(language.toLowerCase()) ?? null;
}

async function readGrammar(url: URL): Promise<Uint8Array> {
  if (url.protocol === "file:") return await Deno.readFile(url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported grammar URL: ${url}`);
  }
  const response = await fetch(url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Loading glisten grammar: HTTP ${response.status} (${url})`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export class IntegrityError extends Error {
  constructor(url: URL) {
    super(`Glisten grammar integrity check failed: ${url}`);
    this.name = "IntegrityError";
  }
}

export class Highlighter {
  private readonly host: Host;

  constructor(
    { load = readGrammar, baseURL: assets = baseURL, ...options }: Options = {},
  ) {
    const base = new URL(assets);
    const modules = new Map<string, Promise<WebAssembly.Module>>();
    this.host = new Host({
      ...options,
      loadLanguage: async (language) => {
        const name = canonicalLanguage(language);
        if (name === null) return undefined;
        let module = modules.get(name);
        if (!module) {
          const artifact = grammars.get(name)!;
          const url = new URL(artifact.file, base);
          module = (async () => {
            const bytes = new Uint8Array(await load(url));
            const digest = new Uint8Array(
              await crypto.subtle.digest("SHA-256", bytes),
            );
            const hash = Array.from(
              digest,
              (byte) => byte.toString(16).padStart(2, "0"),
            ).join("");
            if (hash !== artifact.sha256) throw new IntegrityError(url);
            return await WebAssembly.compile(bytes);
          })();
          modules.set(name, module);
          void module.catch(() => modules.delete(name));
        }
        return await module;
      },
    });
  }

  async highlight(
    language: string,
    source: string | Uint8Array,
  ): Promise<string | null> {
    const name = canonicalLanguage(language);
    if (name === null) return null;
    return await this.host.highlightFull(name, source);
  }
}
