import ts from "npm:typescript@5.9.3";
import config from "./deno.json" with { type: "json" };
import { dirname, fromFileUrl, relative } from "jsr:@std/path@^1.0.6";

const imports: Readonly<Record<string, string>> = config.imports;
const entrypoints = ["mod.ts", "filename.ts"] as const;

function rewriteReferences(
  path: string,
  contents: string,
  resolve: (specifier: string, kind: "module" | "url") => string | undefined,
): string {
  const parsed = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
  );
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent;
      const module = ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        (ts.isCallExpression(parent) &&
          parent.expression.kind === ts.SyntaxKind.ImportKeyword) ||
        (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent));
      const url = ts.isNewExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === "URL" && parent.arguments?.[0] === node;
      const replacement = module
        ? resolve(node.text, "module")
        : url
        ? resolve(node.text, "url")
        : undefined;
      if (replacement !== undefined && replacement !== node.text) {
        edits.push({
          start: node.getStart(parsed),
          end: node.getEnd(),
          text: JSON.stringify(replacement),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    contents = contents.slice(0, edit.start) + edit.text +
      contents.slice(edit.end);
  }
  return contents;
}

export async function copyRuntime(
  source: URL,
  destination: URL,
): Promise<void> {
  const pending = ["host/mod.ts", "filename.ts"];
  const copied = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (copied.has(path)) continue;
    copied.add(path);
    const input = new URL(path, source);
    const output = new URL(path, destination);
    await Deno.mkdir(new URL(".", output), { recursive: true });
    if (path.endsWith(".json")) {
      await Deno.copyFile(input, output);
      continue;
    }

    let contents = await Deno.readTextFile(input);
    if (path === "host/memory.ts") {
      // Deno's WebAssembly memory type also admits SharedArrayBuffer.
      const declaration = "buffer: ArrayBuffer;";
      if (!contents.includes(declaration)) {
        throw new Error(
          "Upstream arena buffer declaration changed; revisit its Deno adaptation",
        );
      }
      contents = contents.replace(
        declaration,
        'buffer: WebAssembly.Memory["buffer"];',
      );
    }
    contents = rewriteReferences(path, contents, (specifier, kind) => {
      if (kind !== "module") return undefined;
      if (specifier.startsWith("#/") || specifier.startsWith(".")) {
        const target = specifier.startsWith("#/")
          ? new URL(specifier.slice(2), source)
          : new URL(specifier, input);
        if (!target.href.startsWith(source.href)) {
          throw new Error(
            `Runtime import escapes upstream source: ${specifier}`,
          );
        }
        pending.push(target.href.slice(source.href.length));
        let replacement = relative(
          dirname(fromFileUrl(input)),
          fromFileUrl(target),
        ).replaceAll("\\", "/");
        if (!replacement.startsWith(".")) replacement = "./" + replacement;
        return replacement;
      }
      const dependency = imports[specifier];
      if (!dependency?.startsWith("jsr:")) {
        throw new Error(`Unexpected upstream runtime dependency: ${specifier}`);
      }
      return dependency;
    });
    await Deno.writeTextFile(output, contents);
  }
}

export async function copyEntrypoints(
  source: URL,
  destination: URL,
): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for (const path of entrypoints) {
    const contents = await Deno.readTextFile(new URL(path, source));
    const packaged = rewriteReferences(
      path,
      contents,
      (specifier) =>
        specifier.startsWith("./build/")
          ? "./" + specifier.slice("./build/".length)
          : undefined,
    );
    await Deno.writeTextFile(new URL(path, destination), packaged);
  }
}

export async function installBuild(staged: URL, output: URL): Promise<void> {
  const files = ["dist", ...entrypoints, "deno.json"];
  await Promise.all(files.map((path) => Deno.lstat(new URL(path, staged))));
  await Deno.mkdir(output, { recursive: true });
  // The output is a separate repository, not a disposable staging directory.
  for (const path of files) {
    const target = new URL(path, output);
    await Deno.remove(target, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    await Deno.rename(new URL(path, staged), target);
  }
}
