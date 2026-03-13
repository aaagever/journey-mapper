import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { screenshotsRouter, cleanAllFiles } from './routes/screenshots.js';
import { exportRouter } from './routes/export.js';
import { FigmaClient } from './figma/client.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);
const STATIC_DIR = path.join(os.tmpdir(), 'journey-mapper');

// Ensure static dir exists, then wipe stale files from previous sessions
fs.mkdirSync(STATIC_DIR, { recursive: true });
cleanAllFiles(STATIC_DIR);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve screenshot files so Figma can fetch them by URL
app.use('/static', express.static(STATIC_DIR));

// Initialize MCP client for Figma
const figmaClient = new FigmaClient();

// Health check - checks both MCP transport AND WebSocket bridge status.
// Uses figma_get_status to verify the Figma Desktop Bridge plugin is connected.
// Debounces true->false transitions to avoid UI flicker from transient failures.
let lastReconnectAttempt = 0;
const RECONNECT_COOLDOWN_MS = 15_000;
let consecutiveBridgeFailures = 0;
let lastBridgeStatus = false;
const BRIDGE_DISCONNECT_THRESHOLD = 2;

app.get('/api/health', async (_req, res) => {
  if (!figmaClient.isConnected()) {
    const now = Date.now();
    if (now - lastReconnectAttempt >= RECONNECT_COOLDOWN_MS) {
      lastReconnectAttempt = now;
      try {
        await figmaClient.connect();
        console.log('Figma MCP client reconnected');
      } catch {
        // Still not available
      }
    }
    consecutiveBridgeFailures = 0;
    lastBridgeStatus = false;
  } else {
    const bridgeReady = await figmaClient.isBridgeReady();
    if (bridgeReady) {
      consecutiveBridgeFailures = 0;
      lastBridgeStatus = true;
    } else {
      consecutiveBridgeFailures++;
      if (consecutiveBridgeFailures >= BRIDGE_DISCONNECT_THRESHOLD) {
        lastBridgeStatus = false;
      }
    }
  }
  res.json({ online: true, figmaConnected: lastBridgeStatus });
});

// Mount routes
app.use('/api/screenshots', screenshotsRouter(STATIC_DIR, PORT));
app.use('/api/export', exportRouter(figmaClient));

// Start server
app.listen(PORT, () => {
  console.log(`Journey Mapper bridge server running on http://localhost:${PORT}`);
  console.log(`Screenshots stored in ${STATIC_DIR}`);

  // Connect to Figma MCP
  figmaClient.connect().then(() => {
    console.log('Figma MCP client connected');
  }).catch((err) => {
    console.warn('Figma MCP client failed to connect (start Figma Desktop + Bridge plugin):', err.message);
  });
});

// Cleanup on shutdown
process.on('SIGINT', () => {
  figmaClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  figmaClient.disconnect();
  process.exit(0);
});
