/**
 * Command Notes Constants
 */

export const COMMAND_NOTES_CONFIG = {
  storageKey: "9remote_command_notes",
  maxNotes: 50
};

// Default popular commands (created if localStorage is empty)
export const DEFAULT_COMMAND_NOTES = [
  { command: "ls -la" },
  { command: "df -h" },
  { command: "free -h" },
  { command: "htop" },
  { command: "grep -rn 'search' ." },
  { command: "docker ps -a" },
  { command: "git status" },
  { command: "git log --oneline -20" },
  { command: "netstat -tlnp" },
  { command: "uname -a" },
];
