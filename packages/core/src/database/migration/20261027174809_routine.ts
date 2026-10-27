import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261027174809_routine",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`routine\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`goal\` text NOT NULL,
          \`trigger\` text NOT NULL,
          \`status\` text NOT NULL,
          \`max_cycles\` integer NOT NULL,
          \`cycles\` integer NOT NULL,
          \`ledger\` text NOT NULL,
          \`fingerprint\` text,
          \`reason\` text,
          \`owner\` text,
          \`lease\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_routine_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`routine_session_idx\` ON \`routine\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`routine_status_idx\` ON \`routine\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
