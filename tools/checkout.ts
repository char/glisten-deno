import { exists } from "../compat/avril-fs.ts";
import { run } from "../compat/avril-std.ts";
import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path@^1.0.6";

export async function checkout(
  dependency: { git: string; rev: string },
  source: URL,
): Promise<void> {
  const { git, rev } = dependency;
  if (!/^[a-f0-9]{40}$/i.test(rev)) {
    throw new Error(
      "Glisten must be pinned to a full Git commit ID in upstream.json",
    );
  }

  // A trailing slash would make lstat follow a source symlink.
  const path = resolve(fromFileUrl(source));
  const current = await Deno.lstat(path).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return undefined;
  });
  if (current && !current.isSymlink) {
    if (!await exists(join(path, ".git"))) {
      throw new Error(
        `Move ${fromFileUrl(source)} aside before fetching glisten`,
      );
    }
    const status = await run("git", [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ], { cwd: path });
    if (status.stdout.length) {
      throw new Error(
        "Glisten source has local changes; refusing to overwrite them",
      );
    }
    const head = await run("git", ["rev-parse", "HEAD"], { cwd: path });
    if (new TextDecoder().decode(head.stdout).trim() === rev.toLowerCase()) {
      return;
    }
  }

  const temporary = await Deno.makeTempDir({
    dir: dirname(path),
    prefix: ".source-",
  });
  try {
    await run("git", ["init", "--quiet", temporary]);
    await run("git", ["fetch", "--depth=1", "--no-tags", "--", git, rev], {
      cwd: temporary,
      stderr: "inherit",
    });
    await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], {
      cwd: temporary,
    });
    if (current) await Deno.remove(path, { recursive: true });
    await Deno.rename(temporary, path);
  } finally {
    await Deno.remove(temporary, { recursive: true }).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}
