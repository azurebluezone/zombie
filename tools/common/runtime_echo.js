export async function execute(args={}) {
  return {echo: args.value ?? null};
}
