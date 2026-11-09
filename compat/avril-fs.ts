export const { makeTempDir, makeTempFile, readFile, writeFile, writeTextFile } =
  Deno;

export async function mkdirs(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
