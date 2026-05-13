type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string;
  [key: string]: unknown;
}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

class Logger {
  private level: LogLevel;

  constructor() {
    this.level = (process.env.LOG_LEVEL as LogLevel) || 'info';
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVELS.indexOf(level) >= LEVELS.indexOf(this.level);
  }

  private format(level: LogLevel, message: string, context?: LogContext): string {
    const ts = new Date().toISOString();
    const ctx = context
      ? ' ' + Object.entries(context).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
      : '';
    return `${ts} [${level.toUpperCase().padEnd(5)}] ${message}${ctx}`;
  }

  debug(message: string, context?: LogContext): void {
    if (this.shouldLog('debug')) console.debug(this.format('debug', message, context));
  }

  info(message: string, context?: LogContext): void {
    if (this.shouldLog('info')) console.info(this.format('info', message, context));
  }

  warn(message: string, context?: LogContext): void {
    if (this.shouldLog('warn')) console.warn(this.format('warn', message, context));
  }

  error(message: string, context?: LogContext): void {
    if (this.shouldLog('error')) console.error(this.format('error', message, context));
  }
}

export const logger = new Logger();
