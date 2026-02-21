import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private channel: vscode.OutputChannel;
  private level: LogLevel;

  constructor(channelName: string = 'Agent Context', level: LogLevel = 'info') {
    this.channel = vscode.window.createOutputChannel(channelName);
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  debug(module: string, message: string): void {
    this.log('debug', module, message);
  }

  info(module: string, message: string): void {
    this.log('info', module, message);
  }

  warn(module: string, message: string): void {
    this.log('warn', module, message);
  }

  error(module: string, message: string): void {
    this.log('error', module, message);
  }

  private log(level: LogLevel, module: string, message: string): void {
    if (LOG_PRIORITY[level] < LOG_PRIORITY[this.level]) {
      return;
    }
    const ts = new Date().toISOString();
    const line = `[${level.toUpperCase()}] [${ts}] [${module}] ${message}`;
    this.channel.appendLine(line);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
