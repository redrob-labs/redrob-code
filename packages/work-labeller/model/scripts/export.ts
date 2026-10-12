// Prints the evaluation set, the prototypes and the training set as JSON, for evaluate.py and train.py.
import { WORK_SAMPLES } from "../eval/work-samples.ts";
import { WORK_PROTOTYPES } from "../prototypes.ts";
import { TRAINING_EXAMPLES } from "../train/index.ts";
import { TUNING_EXAMPLES } from "../train/tuning.ts";

// Bun.write, not console.log: piped, console.log split a multibyte character at a buffer boundary.
await Bun.write(Bun.stdout, `${JSON.stringify({ samples: WORK_SAMPLES, prototypes: WORK_PROTOTYPES, training: TRAINING_EXAMPLES, tuning: TUNING_EXAMPLES })}\n`);
