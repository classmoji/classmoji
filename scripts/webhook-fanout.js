#!/usr/bin/env node
/**
 * scripts/webhook-fanout.js
 * Webhook fanout proxy for parallel development environments
 *
 * Listens on port 4000 (where Smee tunnels point) and forwards incoming
 * webhooks to all active hook-station instances across devport environments.
 *
 * How it works:
 * 1. Scans sibling directories for .devport files
 * 2. Calculates hook-station port for each: 4001 + (ID × 10)
 * 3. Forwards each webhook to ALL active hook-stations in parallel
 */

import http from 'http';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FANOUT_PORT = 4000;
const PROJECT_DIR = join(__dirname, '..');
const PARENT_DIR = dirname(PROJECT_DIR);
const PROJECT_NAME = basename(PROJECT_DIR);

/**
 * Scan for active devport environments and return their hook-station ports
 */
function getActiveHookPorts() {
  const ports = [4001]; // Always include main (ID=0 uses 4001)

  try {
    const dirs = readdirSync(PARENT_DIR);
    for (const dir of dirs) {
      if (dir.startsWith(`${PROJECT_NAME}-`)) {
        const devportFile = join(PARENT_DIR, dir, '.devport');
        if (existsSync(devportFile)) {
          const content = readFileSync(devportFile, 'utf8');
          const match = content.match(/DEVPORT_ID=(\d+)/);
          if (match) {
            const id = parseInt(match[1], 10);
            const hookPort = 4001 + id * 10;
            ports.push(hookPort);
          }
        }
      }
    }
  } catch (err) {
    // Ignore errors scanning directories
    console.log(err);
  }

  return [...new Set(ports)]; // Dedupe
}

/**
 * Forward a request to a target port
 */
function forwardRequest(req, body, targetPort) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `localhost:${targetPort}`,
      },
    };

    const proxyReq = http.request(options, (res) => {
      // Consume response body to free up resources
      res.on('data', () => {});
      res.on('end', () => {
        resolve({ port: targetPort, status: res.statusCode });
      });
    });

    proxyReq.on('error', (err) => {
      resolve({ port: targetPort, status: 'error', message: err.message });
    });

    proxyReq.write(body);
    proxyReq.end();
  });
}

/**
 * Main HTTP server
 */
const server = http.createServer(async (req, res) => {
  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));

  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const ports = getActiveHookPorts();

    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${timestamp}] ${req.method} ${req.url} → ${ports.join(', ')}`);

    // Forward to all active hook-stations in parallel
    const results = await Promise.all(
      ports.map((port) => forwardRequest(req, body, port))
    );

    // Log results
    const summary = results
      .map((r) => `${r.port}:${r.status}`)
      .join(' ');
    console.log(`[${timestamp}] Results: ${summary}`);

    // Respond to the original request (Smee)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      fanout: true,
      forwarded_to: results,
    }));
  });

  req.on('error', (err) => {
    console.error('Request error:', err.message);
    res.writeHead(500);
    res.end('Internal Server Error');
  });
});

server.listen(FANOUT_PORT, () => {
  console.log(`🔀 Webhook fanout proxy listening on port ${FANOUT_PORT}`);
  console.log(`   Forwarding to hook-stations: ${getActiveHookPorts().join(', ')}`);
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down webhook fanout...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
