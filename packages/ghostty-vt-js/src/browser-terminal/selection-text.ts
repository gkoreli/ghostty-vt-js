/**
 * The text a selection copies from one row. Pure, so the rule is tested without a page.
 */
import type { GhosttyCell } from './types.js';

/**
 * The text of one row's selected cells, `colStart` to `colEnd`: each cell's character (its grapheme when it holds more
 * than one codepoint), an empty cell as a space, and trailing spaces trimmed. A cell of width 0, the second half of a
 * wide character (Ghostty's spacer tail) or the cell a wide character left at a row's end (its spacer head), adds
 * nothing, so an emoji or a CJK character copies without a space after it.
 */
export function selectedLineText(
  line: readonly Pick<GhosttyCell, 'codepoint' | 'width' | 'grapheme_len'>[],
  colStart: number,
  colEnd: number,
  graphemeAt: (col: number) => string,
): string {
  let text = '';
  // Where the text ends once trailing spaces are trimmed.
  let lastNonEmpty = -1;
  for (let col = colStart; col <= colEnd; col++) {
    const cell = line[col];
    if (cell && cell.width === 0) continue;
    if (cell && cell.codepoint !== 0) {
      const char = cell.grapheme_len > 0 ? graphemeAt(col) : String.fromCodePoint(cell.codepoint);
      text += char;
      if (char.trim()) lastNonEmpty = text.length;
    } else {
      text += ' ';
    }
  }
  return lastNonEmpty >= 0 ? text.substring(0, lastNonEmpty) : '';
}
