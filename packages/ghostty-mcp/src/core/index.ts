export { listTerminals, readTerminal, readTerminalStyled, sendCommand, pasteText, spawnTerminal, performAction } from "./terminals.js";
export type { Terminal, SpawnOptions, ReadScope, ReadFormat, StyledTerminalContent } from "./types.js";
export { workspace } from "../infrastructure/workspace.js";
export type { Layout, TabChange } from "../domain/workspace.js";
