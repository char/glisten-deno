export const env = Deno.env;
export const rename = Deno.rename;

export async function run(
  command: string,
  args: string[],
  options: Pick<Deno.CommandOptions, "cwd" | "env" | "stdout" | "stderr"> = {},
): Promise<Deno.CommandOutput> {
  const output = await new Deno.Command(command, { ...options, args }).output();
  if (!output.success) {
    throw new Error(`${command} exited with status ${output.code}`);
  }
  return output;
}
