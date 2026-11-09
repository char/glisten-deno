import { Highlighter as Host, ResourceError } from "./build/dist/host/mod.ts";
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
export type Options = NonNullable<ConstructorParameters<typeof Host>[0]> & {
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
  private readonly load: GrammarLoader;
  private readonly baseURL: URL;
  private readonly loaded = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    { load = readGrammar, baseURL: assets = baseURL, ...options }: Options = {},
  ) {
    this.host = new Host(options);
    this.load = load;
    this.baseURL = new URL(assets);
  }

  private async add(language: string): Promise<boolean> {
    const name = canonicalLanguage(language);
    if (name === null || this.loaded.has(name)) return false;
    let pending = this.pending.get(name);
    if (!pending) {
      const artifact = grammars.get(name)!;
      const url = new URL(artifact.file, this.baseURL);
      pending = (async () => {
        const bytes = new Uint8Array(await this.load(url));
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes),
        );
        const hash = Array.from(
          digest,
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        if (hash !== artifact.sha256) throw new IntegrityError(url);
        await this.host.add(await WebAssembly.compile(bytes));
        this.loaded.add(name);
      })().finally(() => this.pending.delete(name));
      this.pending.set(name, pending);
    }
    await pending;
    return true;
  }

  async highlight(
    language: string,
    source: string | Uint8Array,
  ): Promise<string | null> {
    if (canonicalLanguage(language) === null) return null;
    await this.add(language);
    for (;;) {
      const result = this.host._process(language, source);
      if (result.status === "resource") throw new ResourceError();
      const added = await Promise.all(
        result.missing.map((name) => this.add(name)),
      );
      if (added.some(Boolean)) continue;
      return this.host.render(source, result);
    }
  }
}
