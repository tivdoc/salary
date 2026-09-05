import "../production-refusal.mjs";
import { runTopicReadinessCommand, type TopicReadinessCommand } from "../../src/engine/wave2/evidence-audit/topic-readiness-command.ts";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const command = process.argv[2];
if (command !== "status" && command !== "gate") {
  process.stderr.write("WAVE2_TOPIC_READINESS_FAILED command_must_be_status_or_gate\n");
  process.exitCode = 3;
} else {
  const report = runTopicReadinessCommand({
    command: command as TopicReadinessCommand,
    from: option("--from"),
    as_of: option("--as-of"),
    topic: option("--topic"),
    sector: option("--sector"),
    population: option("--population"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.exit_code;
}
