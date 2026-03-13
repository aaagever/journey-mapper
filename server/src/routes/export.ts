import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FigmaClient } from '../figma/client.js';
import {
  generatePlaceSingleFrame,
  generatePlaceTreeFrame,
  generateConnectors,
  type StepData,
} from '../figma/commands.js';
import { computeTreeLayout, type TreeNode } from '../figma/tree-layout.js';
import {
  generatePlacePlaceholderFrame,
  generateTreeConnectors,
} from '../figma/tree-commands.js';
import { cleanAllFiles } from './screenshots.js';

const STATIC_DIR = path.join(os.tmpdir(), 'journey-mapper');

export function exportRouter(figmaClient: FigmaClient): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const { steps } = req.body as { steps: StepData[] };

    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      res.status(400).json({ error: 'No steps provided' });
      return;
    }

    if (!figmaClient.isConnected()) {
      try {
        await figmaClient.connect();
      } catch {
        res.status(503).json({
          error: 'Figma MCP client not connected. Make sure Figma Desktop is running with the Desktop Bridge plugin.',
        });
        return;
      }
    }

    // Verify the Figma Desktop Bridge plugin is actually connected
    const bridgeReady = await figmaClient.isBridgeReady();
    if (!bridgeReady) {
      res.status(503).json({
        error: 'Figma bridge not connected',
        hint: 'Open the Desktop Bridge plugin in Figma',
      });
      return;
    }

    const isTree = steps.some((s) => s.parentId != null);
    console.log(`Export: ${steps.length} steps, mode=${isTree ? 'tree' : 'grid'}`);

    try {
      const frameIds: string[] = [];
      let connectorsResult: unknown = null;

      // Helper: read screenshot for a step and return base64 or null
      const readImage = (step: StepData): string | null => {
        const imageFile = ['.png', '.jpg', '.webp']
          .map((ext) => path.join(STATIC_DIR, `${step.id}${ext}`))
          .find((p) => fs.existsSync(p));
        return imageFile ? fs.readFileSync(imageFile).toString('base64') : null;
      };

      // Helper: collect frame ID from Figma execution result
      const collectFrameId = (result: unknown, index: number): void => {
        if (typeof result === 'string') {
          if (result.startsWith('ERROR:')) {
            const [errMsg, frameId] = result.split('|');
            console.warn(`Frame ${index + 1} image failed: ${errMsg}`);
            if (frameId) frameIds.push(frameId);
          } else {
            frameIds.push(result);
          }
        }
      };

      if (isTree) {
        // --- Tree layout path ---
        const treeNodes: TreeNode[] = steps.map((s) => ({
          id: s.id,
          parentId: s.parentId ?? null,
        }));

        const positionMap = computeTreeLayout(treeNodes);
        console.log('Tree positions:', Object.fromEntries(positionMap));

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const pos = positionMap.get(step.id);
          if (!pos) {
            console.warn(`No position for step ${step.id}, skipping`);
            continue;
          }

          const imageBase64 = readImage(step);
          console.log(`Placing tree frame ${i + 1}/${steps.length} "${step.label}" at (${pos.x}, ${pos.y}) (image: ${imageBase64 ? `${Math.round(imageBase64.length / 1024)}KB base64` : 'URL fallback'})`);

          const result = await figmaClient.execute(
            generatePlaceTreeFrame(step, pos, imageBase64),
          );
          collectFrameId(result, i);
        }

        // Draw tree connectors
        if (steps.length >= 2) {
          connectorsResult = await figmaClient.execute(
            generateTreeConnectors(treeNodes, positionMap),
          );
        }
      } else {
        // --- Grid layout path (V1) ---
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const imageBase64 = readImage(step);
          console.log(`Placing frame ${i + 1}/${steps.length} (image: ${imageBase64 ? `${Math.round(imageBase64.length / 1024)}KB base64` : 'URL fallback'})`);

          const result = await figmaClient.execute(
            generatePlaceSingleFrame(step, i, imageBase64),
          );
          collectFrameId(result, i);
        }

        // Draw linear arrows between consecutive frames
        if (steps.length >= 2) {
          connectorsResult = await figmaClient.execute(generateConnectors(steps.length));
        }
      }

      // Zoom to fit
      await figmaClient.execute('figma.viewport.scrollAndZoomIntoView(figma.currentPage.children)');

      res.json({
        success: true,
        framesPlaced: steps.length,
        frameIds,
        connectors: connectorsResult,
      });
      cleanAllFiles(STATIC_DIR);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error during export';
      console.error('Export error:', message);
      res.status(500).json({ error: message });
      cleanAllFiles(STATIC_DIR);
    }
  });

  // ---------- V2 POC: tree layout test ----------
  router.get('/tree-test', async (_req: Request, res: Response) => {
    if (!figmaClient.isConnected()) {
      try {
        await figmaClient.connect();
      } catch {
        res.status(503).json({ error: 'Figma MCP client not connected' });
        return;
      }
    }

    const bridgeReady = await figmaClient.isBridgeReady();
    if (!bridgeReady) {
      res.status(503).json({
        error: 'Figma bridge not connected',
        hint: 'Open the Desktop Bridge plugin in Figma',
      });
      return;
    }

    // Hard-coded 7-node tree:
    //   Homepage
    //   ├── Login -> Dashboard
    //   ├── Pricing -> Checkout
    //   └── About
    const testTree: TreeNode[] = [
      { id: 'homepage', parentId: null },
      { id: 'login', parentId: 'homepage' },
      { id: 'dashboard', parentId: 'login' },
      { id: 'pricing', parentId: 'homepage' },
      { id: 'checkout', parentId: 'pricing' },
      { id: 'about', parentId: 'homepage' },
    ];

    const labels: Record<string, string> = {
      homepage: 'Homepage',
      login: 'Login',
      dashboard: 'Dashboard',
      pricing: 'Pricing',
      checkout: 'Checkout',
      about: 'About',
    };

    const colors: Record<string, { r: number; g: number; b: number }> = {
      homepage: { r: 0.33, g: 0.15, b: 0.83 },   // purple
      login: { r: 0.2, g: 0.6, b: 0.86 },         // blue
      dashboard: { r: 0.15, g: 0.78, b: 0.55 },    // green
      pricing: { r: 0.95, g: 0.61, b: 0.07 },      // orange
      checkout: { r: 0.9, g: 0.3, b: 0.24 },       // red
      about: { r: 0.56, g: 0.56, b: 0.58 },        // gray
    };

    try {
      // 0. Clear canvas (remove leftover elements from previous runs)
      await figmaClient.execute(
        'figma.currentPage.children.forEach(function(c) { c.remove() })'
      );

      // 1. Compute tree layout
      const positionMap = computeTreeLayout(testTree);

      // 2. Place placeholder frames
      const frameIds: string[] = [];
      for (const node of testTree) {
        const pos = positionMap.get(node.id);
        if (!pos) continue;

        const label = labels[node.id] ?? node.id;
        const color = colors[node.id] ?? { r: 0.5, g: 0.5, b: 0.5 };
        const code = generatePlacePlaceholderFrame(node.id, label, pos, color);
        const result = await figmaClient.execute(code);
        if (typeof result === 'string') frameIds.push(result);
      }

      // 3. Draw tree connectors
      let connectorsResult: unknown = null;
      if (testTree.length >= 2) {
        const code = generateTreeConnectors(testTree, positionMap);
        connectorsResult = await figmaClient.execute(code);
      }

      // 4. Zoom to fit
      await figmaClient.execute(
        'figma.viewport.scrollAndZoomIntoView(figma.currentPage.children)',
      );

      res.json({
        success: true,
        framesPlaced: testTree.length,
        frameIds,
        connectors: connectorsResult,
        positions: Object.fromEntries(positionMap),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Tree test error:', message);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
