import { keccak256, toHex } from "viem";

/**
 * Tasks are deliberately OBJECTIVE + re-executable so validation is trustless and automatable
 * (the TDD's "objectively verifiable deliverable" — the property that makes the slash provable):
 * a worker computes an answer, the validator independently RE-EXECUTES and compares.
 */
export type TaskKind = "sum" | "sort" | "max";
export const TASK_KINDS: TaskKind[] = ["sum", "sort", "max"];

export interface Task {
  kind: TaskKind;
  input: number[];
}

/** Deterministic task generator (stable across runs for reproducible economies). */
export function makeTask(salt: number, kind?: TaskKind): Task {
  const k = kind ?? TASK_KINDS[salt % TASK_KINDS.length];
  const n = 3 + (salt % 5);
  const input = Array.from({ length: n }, (_, i) => (salt * 7 + i * 13) % 97);
  return { kind: k, input };
}

/** The correct answer (used by honest workers AND by validators re-executing). */
export function solve(task: Task): string {
  if (task.kind === "sum") return String(task.input.reduce((a, b) => a + b, 0));
  if (task.kind === "max") return String(Math.max(...task.input));
  return task.input.slice().sort((a, b) => a - b).join(",");
}

/** A worker's submitted answer. Honest = correct; fraud = corrupted (will fail re-execution). */
export function deliver(task: Task, honest: boolean): string {
  const correct = solve(task);
  return honest ? correct : correct + ":TAMPERED";
}

/** Validator re-executes the task and verifies the worker's answer. */
export function verify(task: Task, answer: string): boolean {
  return answer === solve(task);
}

export function deliverableHash(answer: string): `0x${string}` {
  return keccak256(toHex(answer));
}
