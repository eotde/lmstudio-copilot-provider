import * as vscode from 'vscode';
import * as cp from 'child_process';
import { Logger } from '../logger';

export const TERMINAL_TOOL_NAME = 'lmstudio_run_in_terminal';

interface TerminalToolInput {
  command: string;
  cwd?: string;
}

function getWorkspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = Math.floor(maxChars * 0.6);
  const tail = Math.floor(maxChars * 0.3);
  return (
    text.slice(0, head) +
    `\n\n... [${text.length - head - tail} chars omitted] ...\n\n` +
    text.slice(-tail)
  );
}

function makeResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function formatExecutionResult(
  output: string,
  exitCode: number | undefined,
  budgetChars: number,
): string {
  const parts: string[] = [`exit_code: ${exitCode ?? 'unknown'}`];

  if (output.trim()) {
    parts.push(`output:\n${truncate(output.trimEnd(), Math.floor(budgetChars * 0.9))}`);
  } else {
    parts.push('(no output)');
  }

  return parts.join('\n\n');
}

async function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
  token: vscode.CancellationToken,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (token.isCancellationRequested) {
    return undefined;
  }

  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }

  return new Promise((resolve) => {
    let finished = false;
    let cancelDisposable: vscode.Disposable | undefined;

    const finish = (value: vscode.TerminalShellIntegration | undefined) => {
      if (finished) {
        return;
      }
      finished = true;
      disposable.dispose();
      clearTimeout(timeout);
      cancelDisposable?.dispose();
      resolve(value);
    };

    const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        finish(event.shellIntegration);
      }
    });

    const timeout = setTimeout(() => {
      finish(undefined);
    }, timeoutMs);

    cancelDisposable = token.onCancellationRequested(() => {
      finish(undefined);
    });
  });
}

async function createFreshTerminal(
  terminalName: string,
  cwd: string,
  token: vscode.CancellationToken,
  shellIntegrationTimeoutMs: number,
): Promise<{ terminal: vscode.Terminal; shellIntegration: vscode.TerminalShellIntegration | undefined }> {
  const terminal = vscode.window.createTerminal({
    name: terminalName,
    cwd,
    env: { VSCODE_SHELL_INTEGRATION: '1' },
  });
  terminal.show(true);
  const shellIntegration = await waitForShellIntegration(terminal, shellIntegrationTimeoutMs, token);
  return { terminal, shellIntegration };
}

function normalizePathForComparison(inputPath: string): string {
  let result = inputPath.trim();

  if (process.platform === 'win32') {
    result = result.replace(/\//g, '\\').toLowerCase();
    if (result.length > 3) {
      result = result.replace(/[\\]+$/, '');
    }
  } else if (result.length > 1) {
    result = result.replace(/[\/]+$/, '');
  }

  return result;
}

function findTerminalForCwd(terminalName: string, cwd: string): vscode.Terminal | undefined {
  const wanted = normalizePathForComparison(cwd);

  return vscode.window.terminals.find((terminal) => {
    if (terminal.name !== terminalName) {
      return false;
    }

    const terminalCwd = terminal.shellIntegration?.cwd?.fsPath;

    if (!terminalCwd) {
      return false;
    }

    return normalizePathForComparison(terminalCwd) === wanted;
  });
}

function waitForExecutionEnd(
  execution: vscode.TerminalShellExecution,
  timeoutMs: number,
  token: vscode.CancellationToken,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    let finished = false;

    const finish = (exitCode: number | undefined) => {
      if (finished) {
        return;
      }
      finished = true;
      disposable.dispose();
      clearTimeout(timeout);
      cancelDisposable.dispose();
      resolve(exitCode);
    };

    const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution === execution) {
        finish(event.exitCode);
      }
    });

    const timeout = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      disposable.dispose();
      cancelDisposable.dispose();
      reject(new Error(`Command timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    const cancelDisposable = token.onCancellationRequested(() => {
      if (finished) {
        return;
      }
      finished = true;
      disposable.dispose();
      clearTimeout(timeout);
      cancelDisposable.dispose();
      reject(new Error('Command cancelled.'));
    });
  });
}

async function executeInTerminal(
  shellIntegration: vscode.TerminalShellIntegration,
  command: string,
  timeoutMs: number,
  token: vscode.CancellationToken,
): Promise<{ output: string; exitCode: number | undefined }> {

  if (token.isCancellationRequested) {
    throw new Error('Command cancelled.');
  }

  const execution = shellIntegration.executeCommand(command);

  const outputChunks: string[] = [];
  const outputIterator = execution.read()[Symbol.asyncIterator]();

  const readPromise = (async () => {
    while (true) {
      const next = await outputIterator.next();
      if (next.done) {
        break;
      }
      if (token.isCancellationRequested) {
        break;
      }
      outputChunks.push(next.value);
    }
  })();

  try {
    const exitCode = await waitForExecutionEnd(execution, timeoutMs, token);
    await readPromise;
    return {
      output: outputChunks.join(''),
      exitCode,
    };
  } catch (error) {
    await outputIterator.return?.();
    await readPromise.catch(() => undefined);
    throw error;
  }
}

async function executeWithShellFallback(
  command: string,
  cwd: string,
  timeoutMs: number,
  token: vscode.CancellationToken,
): Promise<{ output: string; exitCode: number | undefined }> {
  if (token.isCancellationRequested) {
    throw new Error('Command cancelled.');
  }

  return new Promise((resolve, reject) => {
    let finished = false;

    const finishResolve = (result: { output: string; exitCode: number | undefined }) => {
      if (finished) {
        return;
      }
      finished = true;
      cancelDisposable.dispose();
      resolve(result);
    };

    const finishReject = (error: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      cancelDisposable.dispose();
      reject(error);
    };

    const child = cp.exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10 },
      (error, stdout, stderr) => {
        if (finished) {
          return;
        }

        if (token.isCancellationRequested) {
          finishReject(new Error('Command cancelled.'));
          return;
        }

        const execError = error as cp.ExecException | null;

        if (execError?.killed && execError.signal === 'SIGTERM') {
          finishReject(new Error(`Command timed out after ${timeoutMs} ms.`));
          return;
        }

        const exitCode = typeof execError?.code === 'number' ? execError.code : execError ? 1 : 0;
        const output = `${stdout ?? ''}${stderr ?? ''}`;
        finishResolve({ output, exitCode });
      },
    );

    const cancelDisposable = token.onCancellationRequested(() => {
      child.kill();
      finishReject(new Error('Command cancelled.'));
    });
  });
}

export function createTerminalTool(logger: Logger): vscode.LanguageModelTool<TerminalToolInput> {
  return {
    prepareInvocation: (options) => ({
      invocationMessage: `Running: ${options.input.command}`,
    }),

    invoke: async (options, token) => {
      const config = vscode.workspace.getConfiguration('lmstudio-copilot');
      const enabled = config.get<boolean>('enableTerminalTool', true);
      const command = options.input.command?.trim();
      const timeoutMs = config.get<number>('terminalToolTimeout', 30000);
      const terminalName = config.get<string>('terminalToolName', 'LM Studio Tool Terminal');

      if (!enabled) {
        return makeResult('Terminal tool is disabled (lmstudio-copilot.enableTerminalTool = false).');
      }

      if (!command) {
        return makeResult('No command provided.');
      }

      if (token.isCancellationRequested) {
        return makeResult('Cancelled.');
      }

      const cwd = options.input.cwd?.trim() || getWorkspaceCwd();
      logger.verbose(`[run_in_terminal] cwd=${cwd} cmd=${command}`);

      const shellIntegrationTimeoutMs = 10000;

      // Try to reuse an existing terminal with shell integration for this cwd.
      let terminal = findTerminalForCwd(terminalName, cwd);
      let shellIntegration: vscode.TerminalShellIntegration | undefined;

      if (terminal) {
        terminal.show(true);
        shellIntegration = await waitForShellIntegration(terminal, shellIntegrationTimeoutMs, token);
        if (!shellIntegration) {
          // Existing terminal lost shell integration; dispose it and open a fresh one.
          logger.verbose('[run_in_terminal] existing terminal has no shell integration, recreating');
          terminal.dispose();
          terminal = undefined;
        }
      }

      if (!terminal) {
        const created = await createFreshTerminal(terminalName, cwd, token, shellIntegrationTimeoutMs);
        terminal = created.terminal;
        shellIntegration = created.shellIntegration;
      }

      try {
        const result = shellIntegration
          ? await executeInTerminal(shellIntegration, command, timeoutMs, token)
          : await executeWithShellFallback(command, cwd, timeoutMs, token);
        const output = result.output;
        const exitCode = result.exitCode;

        if (!shellIntegration) {
          logger.warn(
            '[run_in_terminal] VS Code shell integration unavailable; using shell fallback execution',
          );
        }

        logger.verbose(`[run_in_terminal] exit=${exitCode ?? 'unknown'} output=${output.length}b`);

        const budgetChars = options.tokenizationOptions?.tokenBudget
          ? options.tokenizationOptions.tokenBudget * 3
          : 12000;

        return makeResult(formatExecutionResult(output, exitCode, budgetChars));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.verbose(`[run_in_terminal] error: ${message}`);
        return makeResult(`Terminal execution error: ${message}`);
      }
    },
  };
}
