// L8-1 / D2. Every script entry point under scripts/ imports this module FIRST.
//
// The repository is the live site as well as the legal engine. Nothing under
// scripts/ has any business running where NODE_ENV or VERCEL_ENV says
// production (or a Vercel preview): the Pool P imports write draft parameters
// to a catalogue, the proofs write to a development database, the shadow
// runners execute draft law. A script that starts under a production
// environment stops here, before any other import is evaluated — ESM
// evaluates imports in order, and this one comes first by a test's decree —
// with one code on stderr and exit status 2. There is no override flag: an
// override would be the hole this module exists to close.
//
// The refusal is by environment, not by host name, so a script copied into a
// production shell refuses too. The closure proof (scripts/production-closure)
// spawns every entry point under such an environment and expects exactly this.
const nodeEnv = process.env.NODE_ENV;
const vercelEnv = process.env.VERCEL_ENV;
if (nodeEnv === "production" || vercelEnv === "production" || vercelEnv === "preview") {
  process.stderr.write(`PRODUCTION_ENVIRONMENT_REFUSED node_env=${nodeEnv ?? ""} vercel_env=${vercelEnv ?? ""}\n`);
  process.exit(2);
}

export const PRODUCTION_REFUSAL_CODE = "PRODUCTION_ENVIRONMENT_REFUSED";
