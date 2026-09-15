// Letterforms come from the original 4-row font: row 0 carries ascenders only, rows 1-3 are the
// x-height body. `b` and `d` share one bowl and differ only by which stem the `▄` ascender sits
// on, so an ascender must line up with a `█` stem column - 25 for `b`, 13 for `d`.
// `_`, `^` and `~` only add the shadow fill described by `marks`, so they never change a shape.
export const logo = {
  left: [
    "             ▄           ▄   ",
    "█▀▀▄ █▀▀█ █▀▀█ █▀▀▄ █▀▀█ █▀▀█",
    "█___ █^^^ █__█ █___ █__█ █__█",
    "▀~~~ ▀▀▀▀ ▀▀▀▀ ▀~~~ ▀▀▀▀ ▀▀▀▀",
  ],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
