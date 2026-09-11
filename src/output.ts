import { styleText } from "node:util";

export interface Ctx {
  json: boolean;
  debug: boolean;
  command: string;
}

// Human layer. Piped/non-TTY output stays byte-stable JSON (hooks depend on it);
// a terminal gets concise human lines. --json forces JSON everywhere.
const tty = !!process.stdout.isTTY;
const color = tty && !process.env.NO_COLOR;

export const c = (colorName: Parameters<typeof styleText>[0], s: string) =>
  color ? styleText(colorName, s) : s;

export function emitJson(v: unknown) {
  console.log(JSON.stringify(v));
}

// Primary data: JSON unless a human is watching and gave no --json.
export function data(ctx: Ctx, v: unknown, human: () => string) {
  if (ctx.json || !tty) emitJson(v);
  else console.log(human());
}

export function debugLog(ctx: Ctx, ...parts: unknown[]) {
  if (ctx.debug || process.env.DEBUG?.startsWith("beamline")) {
    console.error(c("gray", `[debug] ${parts.map(String).join(" ")}`));
  }
}

// Actionable error on stderr (3.6: diagnostics off the data channel).
// Never throws raw stacks unless --debug.
export function fail(ctx: Ctx, message: string, fix?: string): never {
  const hint = `See 'beamline ${ctx.command} --help'.`;
  console.error(`beamline ${ctx.command}: ${message}.${fix ? ` Fix: ${fix}.` : ""} ${hint}`);
  process.exit(1);
}

export function crash(ctx: Ctx, e: unknown, fix?: string): never {
  if (ctx.debug) console.error(e);
  const msg = e instanceof Error ? e.message : String(e);
  fail(ctx, msg, fix);
}
