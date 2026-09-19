const suites = [
  "test/terminal-screen-emulator.test.mjs",
  "test/browser-terminal-effects.test.mts",
  "test/geometry.test.mts",
  "test/glyph-atlas.test.mts",
  "test/gpu-backend-selection.test.mts",
  "test/context-loss-watchdog.test.mts",
  "test/gpu-frame.test.mts",
  "test/gpu-render-state.test.mts",
  "test/procedural-shapes.test.mts",
  "test/session-authority.test.mts",
] as const;

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const process = Bun.spawn(["bun", suite], {
    cwd: import.meta.dir.replace(/\/scripts$/, ""),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    console.error(`${suite} failed with exit code ${exitCode}`);
    process.exit(exitCode);
  }
}

console.log(`\nAll ${suites.length} VT suites passed.`);
