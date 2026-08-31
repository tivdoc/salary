import { spawnSync } from "node:child_process";
import path from "node:path";

const REQUIRED_NODE_VERSION = "22.22.2";
if (process.versions.node !== REQUIRED_NODE_VERSION) {
  process.stderr.write(`DYNAMIC_NODE_VERSION_UNSUPPORTED:required=${REQUIRED_NODE_VERSION}\n`);
  process.exit(1);
}

const childEnvironment = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value === undefined || name.toUpperCase().startsWith("GIT_")
      || name.toUpperCase() === "NODE_OPTIONS" || name.toUpperCase() === "NODE_PATH") continue;
  childEnvironment[name] = value;
}
const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
childEnvironment.Path = [
  path.dirname(process.execPath),
  "C:\\Program Files\\Git\\cmd",
  path.join(systemRoot, "System32"),
  process.env.Path ?? process.env.PATH ?? "",
].filter(Boolean).join(path.delimiter);
childEnvironment.GIT_NO_REPLACE_OBJECTS = "1";
childEnvironment.GIT_CONFIG_NOSYSTEM = "1";
childEnvironment.GIT_CONFIG_GLOBAL = "NUL";
childEnvironment.GIT_OPTIONAL_LOCKS = "0";

const bootstrap = path.resolve(process.cwd(), "scripts", "canonical-persistence-v091", "bootstrap.mts");
const result = spawnSync(process.execPath, [
  "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
  "--experimental-strip-types",
  "--experimental-transform-types",
  bootstrap,
  ...process.argv.slice(2),
], {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
