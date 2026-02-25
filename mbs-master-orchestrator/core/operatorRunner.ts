import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import type { OperatorConfig, OperatorExecResult, ToolEnvelope } from "../types/index.js";
import { readJSON, nowISO } from "../utils/index.js";
import { ErrorCodes } from "../registry/errors.js";

const ROOT = process.cwd();

function loadConfig(): { operators: OperatorConfig[] } {
  return readJSON(resolve(ROOT, "config/orchestrator.json"));
}

export function getOperator(name: string): ToolEnvelope<OperatorConfig> {
  const config = loadConfig();
  const op = config.operators.find((o) => o.name === name);
  if (!op) {
    return { status: "FAILED", error: { code: ErrorCodes.OPERATOR_NOT_FOUND, message: `Operator "${name}" not found in config` } };
  }
  if (!op.enabled) {
    return { status: "BLOCKED", error: { code: ErrorCodes.OPERATOR_DISABLED, message: `Operator "${name}" is disabled` } };
  }

  const resolvedPath = resolve(ROOT, op.repoPath);
  if (!existsSync(resolvedPath)) {
    return {
      status: "FAILED",
      error: {
        code: ErrorCodes.OPERATOR_PATH_MISSING,
        message: `Operator repo path not found: ${resolvedPath}`,
        details: { configuredPath: op.repoPath, resolvedPath },
      },
    };
  }

  return { status: "EXECUTED", data: { ...op, repoPath: resolvedPath } };
}

export function runOperatorCommand(
  operatorName: string,
  command: string,
  args: string[] = []
): ToolEnvelope<OperatorExecResult> {
  const opResult = getOperator(operatorName);
  if (opResult.status !== "EXECUTED" || !opResult.data) {
    return { status: opResult.status, error: opResult.error };
  }

  const op = opResult.data;
  const fullCmd = `${op.cli} ${command} ${args.join(" ")}`.trim();
  const cwd = resolve(ROOT, op.repoPath);
  const startedAt = nowISO();
  const startMs = Date.now();

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let timedOut = false;

  try {
    const result = execSync(fullCmd, {
      cwd,
      timeout: op.timeoutSeconds * 1000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    stdout = result || "";
  } catch (err: any) {
    if (err.killed) {
      timedOut = true;
      exitCode = 124;
      stderr = `Operator command timed out after ${op.timeoutSeconds}s`;
    } else {
      exitCode = err.status || 1;
      stdout = err.stdout || "";
      stderr = err.stderr || err.message || "";
    }
  }

  const completedAt = nowISO();
  const durationMs = Date.now() - startMs;

  const execResult: OperatorExecResult = {
    operator: operatorName,
    command: fullCmd,
    exitCode,
    stdout,
    stderr,
    durationMs,
    startedAt,
    completedAt,
    timedOut,
  };

  if (timedOut) {
    return {
      status: "FAILED",
      data: execResult,
      error: { code: ErrorCodes.OPERATOR_TIMEOUT, message: `Timed out after ${op.timeoutSeconds}s`, details: { command: fullCmd } },
    };
  }

  if (exitCode !== 0) {
    return {
      status: "FAILED",
      data: execResult,
      error: { code: ErrorCodes.OPERATOR_EXEC_FAILED, message: `Exit code ${exitCode}`, details: { stderr: stderr.slice(0, 500) } },
    };
  }

  return { status: "EXECUTED", data: execResult };
}

export function runMultipleCommands(
  commands: { operator: string; command: string; args: string[] }[]
): { results: ToolEnvelope<OperatorExecResult>[]; allSucceeded: boolean } {
  const results: ToolEnvelope<OperatorExecResult>[] = [];
  for (const cmd of commands) {
    const result = runOperatorCommand(cmd.operator, cmd.command, cmd.args);
    results.push(result);
  }
  const allSucceeded = results.every((r) => r.status === "EXECUTED");
  return { results, allSucceeded };
}
