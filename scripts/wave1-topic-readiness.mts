import { evaluateWave1TopicReadiness } from "../src/engine/legal-knowledge/wave1-topic-readiness.ts";
import {
  wave1SyntheticInactiveEvidence,
  wave1SyntheticReadinessQuery,
} from "../src/engine/legal-knowledge/wave1-synthetic-fixtures.ts";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const query = {
  ...wave1SyntheticReadinessQuery,
  from: flag("--from") ?? wave1SyntheticReadinessQuery.from,
  as_of: flag("--as-of") ?? wave1SyntheticReadinessQuery.as_of,
  topic: flag("--topic") ?? wave1SyntheticReadinessQuery.topic,
  sector: flag("--sector") ?? wave1SyntheticReadinessQuery.sector,
  population: flag("--population") ?? wave1SyntheticReadinessQuery.population,
};

const result = evaluateWave1TopicReadiness({ query, evidence: [wave1SyntheticInactiveEvidence] });
process.stdout.write(`${JSON.stringify({ fixture: "synthetic_inactive_only", result }, null, 2)}\n`);
