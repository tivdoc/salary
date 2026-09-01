import { spawnSync } from "node:child_process";
import path from "node:path";

const childEnvironment = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value === undefined || name.toUpperCase().startsWith("GIT_")
      || name.toUpperCase() === "NODE_OPTIONS" || name.toUpperCase() === "NODE_PATH") continue;
  childEnvironment[name] = value;
}
childEnvironment.NODE_ENV = "test";
childEnvironment.VERCEL_ENV = "";
childEnvironment.GIT_NO_REPLACE_OBJECTS = "1";
childEnvironment.GIT_CONFIG_NOSYSTEM = "1";
childEnvironment.GIT_CONFIG_GLOBAL = "NUL";
childEnvironment.GIT_OPTIONAL_LOCKS = "0";
childEnvironment.HTTP_PROXY = "http://127.0.0.1:9";
childEnvironment.HTTPS_PROXY = "http://127.0.0.1:9";
childEnvironment.ALL_PROXY = "http://127.0.0.1:9";
childEnvironment.NO_PROXY = "127.0.0.1,localhost";

const bootstrap = path.resolve(process.cwd(), "scripts", "product-integration", "durable-postgres", "bootstrap.mts");
const result = spawnSync(process.execPath, [
  "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
  "--experimental-strip-types",
  "--experimental-transform-types",
  bootstrap,
], {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
