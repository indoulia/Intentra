import { execFile } from 'node:child_process';
import type { Clock } from '@agentos/contracts';
import type { ProcessResult, ProcessRunner } from './ports.js';

/**
 * The real host, behind the ports the rest of the package uses.
 *
 * `adapters/` is the one package permitted to reach a process (KERNEL_BOUNDARY dependency
 * rule 5), and this is where it does. Everything else in the package talks to
 * `ProcessRunner`, which is why the git adapter can be tested against a scripted host rather
 * than against whichever git happens to be installed on the machine running the suite.
 */

/** Wall-clock time. Injected everywhere so a replay is reproducible. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Runs a command with no shell.
 *
 * No shell, ever: the arguments are passed as an array, so a filename containing a space, a
 * quote or a semicolon is a filename and not a second command. That is not a hardening
 * measure bolted on afterwards — it is the only reason the path confinement above this layer
 * means anything, since a confined path that is then interpolated into a shell string is a
 * confined path that has escaped.
 *
 * A command that could not be started is `started: false`, which is a different fact from a
 * command that ran and failed. The availability probes read exactly that difference to tell
 * `NOT_CONFIGURED` from `UNAVAILABLE`.
 */
export class NodeProcessRunner implements ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly timeoutMs: number },
  ): Promise<ProcessResult> {
    return new Promise<ProcessResult>((resolve) => {
      execFile(
        command,
        [...args],
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          shell: false,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout, stderr, started: true });
            return;
          }
          const failure = error as NodeJS.ErrnoException & { code?: number | string };
          const notStarted = failure.code === 'ENOENT' || failure.code === 'EACCES';
          resolve({
            code: typeof failure.code === 'number' ? failure.code : null,
            stdout,
            stderr: stderr.length > 0 ? stderr : error.message,
            started: !notStarted,
          });
        },
      );
    });
  }
}

/**
 * A runner that starts nothing, for a host where running commands is not permitted.
 *
 * It reports `started: false` rather than throwing, so every caller takes the same branch it
 * would take on a host with no git installed: `NOT_CONFIGURED`, and observations that are
 * `UNAVAILABLE` rather than absent.
 */
export const NO_PROCESS_RUNNER: ProcessRunner = {
  run(command: string): Promise<ProcessResult> {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr:
        `this AgentOS installation is configured to run no commands, so ${command} was not `
        + 'started. Nothing is claimed about what it would have reported',
      started: false,
    });
  },
};
