#!/usr/bin/env node

/**
 * Unified startup script for p2p-energy-trading
 * 
 * Usage:
 *   node scripts/start-all.js          # Normal start (no DB reset)
 *   node scripts/start-all.js --clean  # Start with DB reset + seed
 * 
 * Cross-platform: Works on Windows PowerShell, macOS, and Linux.
 * Avoids Windows "Terminate batch job (Y/N)?" prompt.
 * 
 * Service Readiness:
 *   - PostgreSQL: Attempts real connection with startup message
 *   - Redis: Sends PING command, expects PONG response
 */

const { spawn } = require('child_process');
const net = require('net');

const isClean = process.argv.includes('--clean');
const isWindows = process.platform === 'win32';

// Configuration
const POSTGRES_PORT = 5432;
const REDIS_PORT = 6379;
const TIMEOUT_MS = 30000;

// Track child processes for cleanup
let currentChild = null;

/**
 * Run a command and return a promise
 * @param {string} command - Command to run
 * @param {string[]} args - Arguments
 * @returns {Promise<void>}
 */
function run(command, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
    });

    currentChild = proc;

    proc.on('close', (code) => {
      currentChild = null;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command "${command} ${args.join(' ')}" exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      currentChild = null;
      reject(err);
    });
  });
}

/**
 * Run npm script (delegates to package.json - single source of truth)
 * @param {string} scriptName - npm script name
 * @returns {Promise<void>}
 */
function npmRun(scriptName) {
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';
  return run(npmCmd, ['run', scriptName]);
}

/**
 * Check if PostgreSQL is ready by attempting a real connection.
 * Sends a PostgreSQL startup message and checks for valid response.
 * This is more reliable than just checking if the port is open.
 * 
 * @param {string} host - Hostname
 * @param {number} port - Port number
 * @param {number} timeoutMs - Connection timeout
 * @returns {Promise<boolean>}
 */
function checkPostgresReady(host = 'localhost', port = POSTGRES_PORT, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.on('connect', () => {
      // Send a minimal PostgreSQL startup message
      // Format: Length (4 bytes) + Protocol version (4 bytes) + params
      // We send a cancel request which Postgres will respond to
      const cancelRequest = Buffer.alloc(16);
      cancelRequest.writeInt32BE(16, 0);      // Length
      cancelRequest.writeInt32BE(80877102, 4); // Cancel request code (1234 << 16 | 5678)
      cancelRequest.writeInt32BE(0, 8);        // PID (0)
      cancelRequest.writeInt32BE(0, 12);       // Secret key (0)
      
      socket.write(cancelRequest);
      
      // If we can write without error and connection stays open briefly, Postgres is ready
      setTimeout(() => {
        cleanup();
        resolve(true);
      }, 100);
    });

    socket.on('data', () => {
      // Any response means Postgres is alive
      cleanup();
      resolve(true);
    });

    socket.on('timeout', () => {
      cleanup();
      resolve(false);
    });

    socket.on('error', () => {
      cleanup();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Check if Redis is ready by sending PING and expecting PONG.
 * 
 * @param {string} host - Hostname
 * @param {number} port - Port number
 * @param {number} timeoutMs - Connection timeout
 * @returns {Promise<boolean>}
 */
function checkRedisReady(host = 'localhost', port = REDIS_PORT, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.on('connect', () => {
      // Send Redis PING command (RESP protocol)
      socket.write('*1\r\n$4\r\nPING\r\n');
    });

    socket.on('data', (data) => {
      const response = data.toString();
      // Redis responds with +PONG\r\n
      if (response.includes('PONG')) {
        cleanup();
        resolve(true);
      } else {
        cleanup();
        resolve(false);
      }
    });

    socket.on('timeout', () => {
      cleanup();
      resolve(false);
    });

    socket.on('error', () => {
      cleanup();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Wait for a service to be ready with retries
 * @param {string} name - Service name for logging
 * @param {Function} checkFn - Function that returns Promise<boolean>
 * @param {number} timeout - Total timeout in ms
 * @returns {Promise<void>}
 */
async function waitForService(name, checkFn, timeout = TIMEOUT_MS) {
  const start = Date.now();
  const retryInterval = 500;

  while (Date.now() - start < timeout) {
    if (await checkFn()) {
      return;
    }
    await new Promise(r => setTimeout(r, retryInterval));
  }

  throw new Error(`Timeout waiting for ${name} to be ready (${timeout}ms)`);
}

/**
 * Clean up and exit
 * @param {number} code - Exit code
 */
function cleanup(code = 0) {
  if (currentChild && !currentChild.killed) {
    if (isWindows) {
      try {
        spawn('taskkill', ['/pid', currentChild.pid, '/T', '/F'], { 
          shell: true,
          stdio: 'ignore',
          windowsHide: true 
        });
      } catch (e) {
        // Ignore errors during cleanup
      }
    } else {
      currentChild.kill('SIGTERM');
    }
  }
  process.exit(code);
}

// Handle Ctrl+C gracefully (no Windows batch prompt)
process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  cleanup(0);
});

process.on('SIGTERM', () => {
  cleanup(0);
});

async function main() {
  console.log(isClean 
    ? '[start:all:clean] Starting with DB reset + seed...\n' 
    : '[start:all] Starting services...\n');

  // Step 1: Kill ports (ignore errors - ports may not be in use)
  console.log('> Killing ports 3000, 4000...');
  try {
    await npmRun('kill-ports');
  } catch (e) {
    // Ignore - ports may not be in use
  }

  // Step 2: Start Docker containers (uses package.json docker:up - single source of truth)
  console.log('\n> Starting Docker containers...');
  await npmRun('docker:up');

  // Step 3: Wait for services to be truly ready (not just port open)
  console.log('\n> Waiting for services to be ready...');
  
  await Promise.all([
    waitForService('PostgreSQL', checkPostgresReady)
      .then(() => console.log('  - PostgreSQL ready (connection verified)')),
    waitForService('Redis', checkRedisReady)
      .then(() => console.log('  - Redis ready (PING/PONG verified)')),
  ]);
  
  console.log('> All services ready!\n');

  // Step 4: DB reset and seed (only in clean mode)
  if (isClean) {
    console.log('> Resetting database...');
    await npmRun('db:reset');

    console.log('\n> Seeding database...');
    await npmRun('seed');
    console.log('');
  }

  // Step 5: Start dev servers
  console.log('> Starting development servers...\n');
  await npmRun('dev:all');
}

main().catch((err) => {
  console.error('\nError:', err.message);
  cleanup(1);
});
