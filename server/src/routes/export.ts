import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FigmaClient } from '../figma/client.js';
import {
  generatePlaceSingleFrame,
  generateConnectors,
  type StepData,
} from '../figma/commands.js';
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

    try {
      // 1. Place frames one at a time to keep message sizes manageable
      const frameIds: string[] = [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        // Read image file and convert to base64
        let imageBase64: string | null = null;
        const imageFile = ['.png', '.jpg', '.webp']
          .map((ext) => path.join(STATIC_DIR, `${step.id}${ext}`))
          .find((p) => fs.existsSync(p));
        if (imageFile) {
          imageBase64 = fs.readFileSync(imageFile).toString('base64');
        }

        console.log(`Placing frame ${i + 1}/${steps.length} (image: ${imageBase64 ? `${Math.round(imageBase64.length / 1024)}KB base64` : 'URL fallback'})`);

        const result = await figmaClient.execute(
          generatePlaceSingleFrame(step, i, imageBase64),
        );

        if (typeof result === 'string') {
          if (result.startsWith('ERROR:')) {
            const [errMsg, frameId] = result.split('|');
            console.warn(`Frame ${i + 1} image failed: ${errMsg}`);
            if (frameId) frameIds.push(frameId);
          } else {
            frameIds.push(result);
          }
        }
      }

      // 2. Draw arrows between consecutive frames
      let connectorsResult: unknown = null;
      if (steps.length >= 2) {
        connectorsResult = await figmaClient.execute(generateConnectors(steps.length));
      }

      // 3. Zoom to fit
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

  return router;
}
