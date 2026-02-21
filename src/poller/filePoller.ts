import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../util/logger';

const MODULE = 'FilePoller';
const MAX_CHUNK_BYTES = 10 * 1024 * 1024; // 10 MB safety cap per poll

export interface FilePollerOptions {
  filePath: string;
  pollIntervalMs: number;
}

export type DataCallback = (chunk: string) => void;

export class FilePoller implements vscode.Disposable {
  private options: FilePollerOptions;
  private logger: Logger;
  private fileOffset: number = 0;
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy: boolean = false;
  private consecutiveSkips: number = 0;
  private disposed: boolean = false;
  private onDataCallback: DataCallback | undefined;
  private onResetCallback: (() => void) | undefined;
  private onFileNotFound: (() => void) | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: FilePollerOptions, logger: Logger) {
    this.options = { ...options };
    this.logger = logger;
  }

  onData(callback: DataCallback): void {
    this.onDataCallback = callback;
  }

  onReset(callback: () => void): void {
    this.onResetCallback = callback;
  }

  onMissing(callback: () => void): void {
    this.onFileNotFound = callback;
  }

  start(): void {
    if (this.disposed) { return; }
    if (!this.options.filePath) {
      this.logger.info(MODULE, 'No log file path configured');
      return;
    }

    this.logger.info(MODULE, `Starting file poller for: ${this.options.filePath}`);

    try {
      const dirPath = path.dirname(this.options.filePath);
      const fileName = path.basename(this.options.filePath);
      const pattern = new vscode.RelativePattern(vscode.Uri.file(dirPath), fileName);
      this.watcher = vscode.workspace.createFileSystemWatcher(pattern, true, false, true);
      this.watcher.onDidChange(() => this.debouncedPoll());
    } catch (err) {
      this.logger.warn(MODULE, `FileSystemWatcher setup failed, relying on interval polling: ${err}`);
    }

    this.timer = setInterval(() => { void this.poll(); }, this.options.pollIntervalMs);

    void this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = undefined;
    }
    this.busy = false;
    this.consecutiveSkips = 0;
  }

  reconfigure(options: Partial<FilePollerOptions>): void {
    const needsRestart = options.filePath !== undefined && options.filePath !== this.options.filePath;
    Object.assign(this.options, options);

    if (needsRestart) {
      this.stop();
      this.fileOffset = 0;
      this.start();
    } else if (options.pollIntervalMs !== undefined) {
      if (this.timer) {
        clearInterval(this.timer);
      }
      this.timer = setInterval(() => { void this.poll(); }, this.options.pollIntervalMs);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.logger.debug(MODULE, 'FilePoller disposed');
  }

  private debouncedPoll(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => { void this.poll(); }, 500);
  }

  private async poll(): Promise<void> {
    if (this.disposed || !this.options.filePath) { return; }

    if (this.busy) {
      this.consecutiveSkips++;
      if (this.consecutiveSkips >= 3) {
        this.logger.warn(MODULE, `3+ consecutive poll skips. Consider increasing pollIntervalMs (current: ${this.options.pollIntervalMs}).`);
      }
      return;
    }

    this.busy = true;
    this.consecutiveSkips = 0;

    try {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(this.options.filePath);
      } catch {
        this.logger.debug(MODULE, 'Log file does not exist');
        this.onFileNotFound?.();
        return;
      }

      if (stat.size < this.fileOffset) {
        this.logger.warn(MODULE, `File truncated/rotated (size ${stat.size} < offset ${this.fileOffset}). Resetting.`);
        this.fileOffset = 0;
        this.onResetCallback?.();
      }

      if (stat.size === this.fileOffset) {
        return;
      }

      const available = stat.size - this.fileOffset;
      const bytesToRead = Math.min(available, MAX_CHUNK_BYTES);
      if (available > MAX_CHUNK_BYTES) {
        this.logger.warn(MODULE, `Log file grew by ${available} bytes; capping read to ${MAX_CHUNK_BYTES} bytes to protect memory. Remaining data will be read on subsequent polls.`);
      }
      const buffer = Buffer.alloc(bytesToRead);
      const fh = await fs.promises.open(this.options.filePath, 'r');
      try {
        await fh.read(buffer, 0, bytesToRead, this.fileOffset);
      } finally {
        await fh.close();
      }

      this.fileOffset += bytesToRead;
      const chunk = buffer.toString('utf-8');

      this.onDataCallback?.(chunk);
    } catch (err) {
      this.logger.error(MODULE, `Poll error: ${err}`);
    } finally {
      this.busy = false;
    }
  }
}
