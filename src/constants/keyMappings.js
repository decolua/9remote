// Terminal keyboard escape sequences mapping

export const SPECIAL_KEYS = {
  "ArrowUp": "\x1b[A",
  "ArrowDown": "\x1b[B",
  "ArrowRight": "\x1b[C",
  "ArrowLeft": "\x1b[D",
  "Escape": "\x1b",
  "Tab": "\t",
  "Enter": "\r",
  "Backspace": "\x7f",
  "Delete": "\x1b[3~",
  "Home": "\x1b[H",
  "End": "\x1b[F",
  "PageUp": "\x1b[5~",
  "PageDown": "\x1b[6~",
  "Insert": "\x1b[2~",
  "F1": "\x1bOP",
  "F2": "\x1bOQ",
  "F3": "\x1bOR",
  "F4": "\x1bOS",
  "F5": "\x1b[15~",
  "F6": "\x1b[17~",
  "F7": "\x1b[18~",
  "F8": "\x1b[19~",
  "F9": "\x1b[20~",
  "F10": "\x1b[21~",
  "F11": "\x1b[23~",
  "F12": "\x1b[24~"
};

// Ctrl + Arrow keys mapping
export const CTRL_ARROW_KEYS = {
  "ArrowUp": "\x1b[1;5A",
  "ArrowDown": "\x1b[1;5B",
  "ArrowRight": "\x1b[1;5C",
  "ArrowLeft": "\x1b[1;5D"
};
