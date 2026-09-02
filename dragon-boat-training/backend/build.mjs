import fs from "node:fs/promises";

const sourceDirectory = new URL("./src/", import.meta.url);
const outputDirectory = new URL("./.build/", import.meta.url);
const outputFile = new URL("./.build/Code.gs", import.meta.url);
const sourceOrder = [
  "Config.gs",
  "Security.gs",
  "SystemStore.gs",
  "TimeUtils.gs",
  "SeasonStore.gs",
  "SeasonActions.gs",
  "ScheduleActions.gs",
  "PublicActions.gs",
  "CoachActions.gs",
  "Setup.gs",
  "Code.gs"
];

const sources = await Promise.all(sourceOrder.map(async (fileName) => {
  const source = await fs.readFile(new URL(fileName, sourceDirectory), "utf8");
  return `// ---- ${fileName} ----\n${source.trim()}\n`;
}));

await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(outputFile, sources.join("\n"), "utf8");
console.log(new URL(outputFile).pathname.replace(/^\/(.:)/, "$1"));
