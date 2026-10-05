#!/usr/bin/env bun
/**
 * Development launcher: runs the Bun API server (watch mode) and the Vite dev
 * server for the web client side by side, prefixing and forwarding their output.
 *
 * Usage: bun run dev
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

interface Task {
  readonly name: string;
  readonly color: string;
  readonly command: readonly string[];
}

const tasks: readonly Task[] = [
  { name: "server", color: "\u001b[36m", command: ["bun", "--watch", "packages/server/src/index.ts"] },
  { name: "web", color: "\u001b[35m", command: ["bun", "run", "--cwd", "packages/web", "dev"] },
];

const children = tasks.map((task) => {
  const child = Bun.spawn([...task.command], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  void pipe(child.stdout, task);
  void pipe(child.stderr, task);
  return { task, child };
});

async function pipe(stream: ReadableStream<Uint8Array>, task: Task): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk);
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      process.stdout.write(`${task.color}[${task.name}]\u001b[0m ${line}\n`);
    }
  }
}

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) child.kill();
  await Promise.all(children.map(({ child }) => child.exited.catch(() => undefined)));
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

for (const { task, child } of children) {
  void child.exited.then((code) => {
    if (!shuttingDown) {
      process.stderr.write(`\u001b[31m[${task.name}] exited with code ${code}\u001b[0m\n`);
      void shutdown(code);
    }
  });
}
