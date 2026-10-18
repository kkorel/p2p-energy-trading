/**
 * Simple Logger with transaction_id and action tracking
 */

export interface LogContext {
  transaction_id?: string;
  message_id?: string;
  action?: string;
  service?: string;
  [key: string]: any; // Allow additional properties
}

function formatLog(level: string, message: string, context?: LogContext): string {
  const timestamp = new Date().toISOString();
  const parts = [
    `[${timestamp}]`,
    `[${level}]`,
  ];
  
  if (context?.service) {
    parts.push(`[${context.service}]`);
  }
  
  if (context?.action) {
    parts.push(`[${context.action}]`);
  }
  
  if (context?.transaction_id) {
    parts.push(`[txn:${context.transaction_id.substring(0, 8)}]`);
  }
  
  if (context?.message_id) {
    parts.push(`[msg:${context.message_id.substring(0, 8)}]`);
  }
  
  parts.push(message);
  
  return parts.join(' ');
}

export function createLogger(service: string) {
  return {
    info(message: string, context?: Omit<LogContext, 'service'>) {
      console.log(formatLog('INFO', message, { ...context, service }));
    },
    
    warn(message: string, context?: Omit<LogContext, 'service'>) {
      console.warn(formatLog('WARN', message, { ...context, service }));
    },
    
    error(message: string, context?: Omit<LogContext, 'service'>) {
      console.error(formatLog('ERROR', message, { ...context, service }));
    },
    
    debug(message: string, context?: Omit<LogContext, 'service'>) {
      if (process.env.DEBUG) {
        console.log(formatLog('DEBUG', message, { ...context, service }));
      }
    },
  };
}
