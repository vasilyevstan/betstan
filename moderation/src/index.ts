import { createDefaultModerationRuntime } from "./runtime/ModerationRuntime";

export const startUp = async () => {
  console.log("Starting up...");
  const runtime = createDefaultModerationRuntime();
  await runtime.start();
  return runtime;
};

if (require.main === module) {
  void startUp().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
