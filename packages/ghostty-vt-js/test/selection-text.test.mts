/**
 * Tests for the text a selection copies from a row: a wide character's second cell adds nothing, empty cells inside the
 * row are spaces, trailing spaces go, and a cell with several codepoints copies its grapheme.
 *
 * Run: bun test/selection-text.test.mts
 */

import { strict as assert } from "node:assert";

import { selectedLineText } from "../src/browser-terminal/selection-text.js";

const cell = (char: string | null, width = 1, grapheme_len = 0) => ({ codepoint: char ? char.codePointAt(0)! : 0, width, grapheme_len });
const spacer = cell(null, 0);
const none = () => "";

const row = [cell("┌"), cell("─"), cell("┐"), cell(" "), cell("🚀", 2), spacer, cell(" "), cell("é"), cell(null), cell(null)];
assert.equal(selectedLineText(row, 0, row.length - 1, none), "┌─┐ 🚀 é", "an emoji copies without a space after it");
assert.equal(selectedLineText([cell("漢", 2), spacer, cell("字", 2), spacer], 0, 3, none), "漢字", "nor does a CJK character");
assert.equal(selectedLineText([cell("a"), cell(null), cell("b"), cell(" "), cell(null)], 0, 4, none), "a b", "an empty cell inside the row is a space; trailing ones go");
assert.equal(selectedLineText([cell(null), cell(" ")], 0, 1, none), "", "a row of nothing copies nothing");
assert.equal(selectedLineText([cell("👍", 2, 1), spacer, cell("x")], 0, 2, (col) => (col === 0 ? "👍🏽" : "?")), "👍🏽x", "a cell with several codepoints copies its grapheme");
assert.equal(selectedLineText(row, 4, 7, none), "🚀 é", "a selection from the middle of a row");
console.log("✅ selection text: a wide character's second cell adds nothing\n\n1 selection-text test passed");
