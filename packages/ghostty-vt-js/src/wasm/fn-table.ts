/**
 * JS → WASM function-pointer installation (the "synthetic module" trick).
 *
 * # Why this file exists
 *
 * libghostty-vt's effect callbacks (`GHOSTTY_TERMINAL_OPT_WRITE_PTY`, `_BELL`,
 * `_TITLE_CHANGED`, ... — `terminal.h:60-95`) are C function pointers. In WASM,
 * a "C function pointer" is an index into the module's indirect function table
 * (`__indirect_function_table`, exported by our `ghostty-vt.wasm` build).
 *
 * The naive way to put a JS function into that table is `WebAssembly.Function`
 * (the js-types / Type Reflection proposal), which as of 2026-07 is still NOT
 * shipped by default in stable Chrome or Bun (V8 gates it behind
 * `--experimental-wasm-type-reflection`; JSC doesn't expose it). Wasm 3.0
 * (2025-09) did not change this — typed function references are a *core spec*
 * feature; synthesizing a typed wasm function from JS lives in the separate
 * JS-API proposal.
 *
 * # The trick (works in every runtime, today)
 *
 * `WebAssembly.Function`'s only job is to give a JS function a wasm type. But a
 * ~50-byte synthetic module that IMPORTS a JS function and immediately
 * RE-EXPORTS it produces an "Exported Function" — which carries a declared wasm
 * type and is therefore legal to store in a `funcref` table in every engine:
 *
 * ```
 * (module
 *   (import "e" "f" (func $f (param i32 i32 ...) (result ...)))
 *   (export "f" (func $f)))
 * ```
 *
 * We assemble that module's binary by hand (it has no code section — just
 * type/import/export), instantiate it with the JS function as the import, grow
 * `__indirect_function_table`, store the export, and hand the index to
 * `ghostty_terminal_set()` as the "function pointer".
 *
 * # Rules (violate these and you get engine traps or corrupted state)
 *
 * 1. **The wasm signature must match the C typedef exactly.** Pointers,
 *    lengths, handles and `void*` are all `i32` on wasm32; `size_t` is `i32`;
 *    a C `bool` return is `i32`. A mismatch traps with "indirect call type
 *    mismatch" at *call* time (i.e. mid-`vt_write`), not at install time.
 * 2. **Table indices are per-instance.** An index acquired from one WASM
 *    instance's table means nothing to another instance. Never cache indices
 *    across instances.
 * 3. **Indices must outlive the consumer.** If a table slot is released (or
 *    overwritten) while a terminal still has it registered as a callback, the
 *    next triggering VT sequence traps. Release slots only after clearing the
 *    registration (`ghostty_terminal_set(term, OPT, 0)`) or freeing the
 *    terminal.
 * 4. **Slots are recycled, not shrunk.** `WebAssembly.Table` cannot shrink.
 *    {@link FnTable} keeps a free-list so long-lived hosts (a browser tab
 *    opening many terminals) don't leak table slots.
 * 5. **What the callback may do is governed by the *callee's* contract**, not
 *    by this file. For libghostty-vt effects see `../browser-terminal/vt/effects.ts`
 *    — most importantly: never re-enter `ghostty_terminal_vt_write` from
 *    inside a callback.
 *
 * This file is platform-agnostic (no DOM, no Node APIs) — it works identically
 * in browsers, Node, and Bun.
 */

/** WASM value type byte codes (binary format §5.3.1). */
export const WasmValType = {
  I32: 0x7f,
  I64: 0x7e,
  F32: 0x7d,
  F64: 0x7c,
} as const;

export type WasmValTypeCode = (typeof WasmValType)[keyof typeof WasmValType];

/** Unsigned LEB128 encoding (wasm binary format integers). */
function uleb(n: number): number[] {
  const bytes: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    bytes.push(b);
  } while (n !== 0);
  return bytes;
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

/**
 * Assemble the binary for `(module (import "e" "f" (func <sig>)) (export "f" (func 0)))`.
 *
 * Sections: type (id 1), import (id 2), export (id 7). No code section — the
 * one function is the import itself, re-exported.
 */
function buildReExportModule(params: readonly WasmValTypeCode[], results: readonly WasmValTypeCode[]): Uint8Array {
  const typeSection = section(1, [
    0x01, // one type entry
    0x60, // func type
    ...uleb(params.length),
    ...params,
    ...uleb(results.length),
    ...results,
  ]);
  // import "e" "f" (func, type index 0)
  const importSection = section(2, [0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00]);
  // export "f" = func index 0
  const exportSection = section(7, [0x01, 0x01, 0x66, 0x00, 0x00]);
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // magic "\0asm"
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSection,
    ...importSection,
    ...exportSection,
  ]);
}

/**
 * Wrap a JS function as a *typed wasm exported function* — the
 * `WebAssembly.Function` substitute described in the file header.
 *
 * Synchronous by design: the synthetic module is tiny and
 * `new WebAssembly.Module` on <100 bytes is microseconds. (Some engines warn
 * about sync compilation of *large* modules on the main thread; this is 50
 * bytes.)
 *
 * @param jsFn - The JS function to wrap. It receives the raw wasm values
 *   (numbers) — pointer arguments must be dereferenced against the target
 *   instance's `memory` by the caller.
 * @param params - Parameter types matching the C typedef (rule 1 above).
 * @param results - Result types (empty for `void`).
 */
export function wrapAsWasmFunction(
  jsFn: (...args: number[]) => number | void,
  params: readonly WasmValTypeCode[],
  results: readonly WasmValTypeCode[] = [],
): WebAssembly.ExportValue & CallableFunction {
  const module = new WebAssembly.Module(buildReExportModule(params, results) as BufferSource);
  const instance = new WebAssembly.Instance(module, { e: { f: jsFn } });
  return instance.exports.f as WebAssembly.ExportValue & CallableFunction;
}

/** A table slot holding an installed JS callback. See {@link FnTable.install}. */
export interface InstalledFn {
  /**
   * The table index — pass this as the C "function pointer" value (e.g. the
   * `value` argument of `ghostty_terminal_set`).
   */
  readonly index: number;
  /**
   * Return the slot to the free-list. Only call after no C-side consumer can
   * invoke the pointer anymore (rule 3 in the file header).
   */
  release(): void;
}

/**
 * Slot allocator over a module's `__indirect_function_table`.
 *
 * One `FnTable` per WASM instance (rule 2). Grows the table on demand and
 * recycles released slots (rule 4). Create it once next to the instance and
 * share it among all consumers of that instance.
 */
export class FnTable {
  private readonly table: WebAssembly.Table;
  private readonly freeSlots: number[] = [];

  constructor(table: WebAssembly.Table) {
    this.table = table;
  }

  /**
   * Install a JS function into the table and return its index.
   *
   * @param jsFn - JS callback receiving raw wasm values (numbers).
   * @param params - Wasm parameter types matching the C typedef exactly.
   * @param results - Wasm result types (empty for `void`).
   */
  install(
    jsFn: (...args: number[]) => number | void,
    params: readonly WasmValTypeCode[],
    results: readonly WasmValTypeCode[] = [],
  ): InstalledFn {
    const wrapped = wrapAsWasmFunction(jsFn, params, results);
    const index = this.freeSlots.pop() ?? this.table.grow(1);
    this.table.set(index, wrapped);

    let released = false;
    return {
      index,
      release: () => {
        if (released) return;
        released = true;
        this.table.set(index, null);
        this.freeSlots.push(index);
      },
    };
  }
}
