import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';

export const IMAGE_EXTS = ['.png', '.jpg', '.webp'];

/** Delete all image files from a directory. Best-effort: logs errors, never throws. */
export function cleanAllFiles(dir: string): void {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => IMAGE_EXTS.some((ext) => f.endsWith(ext)));
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(dir, file));
      } catch (err) {
        console.warn(`Failed to delete ${file}:`, err);
      }
    }
    if (files.length > 0) console.log(`Cleaned ${files.length} screenshot(s) from ${dir}`);
  } catch (err) {
    console.warn('cleanAllFiles error:', err);
  }
}

export function screenshotsRouter(staticDir: string, port: number): Router {
  const router = Router();

  // POST - receive a screenshot (base64 data URL), save to disk
  router.post('/', (req: Request, res: Response) => {
    const { id, imageDataUrl } = req.body;

    if (!id || !imageDataUrl) {
      res.status(400).json({ error: 'Missing id or imageDataUrl' });
      return;
    }

    // Strip data URL prefix to get raw base64
    const base64Match = imageDataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!base64Match) {
      res.status(400).json({ error: 'Invalid image data URL format' });
      return;
    }

    const ext = base64Match[1] === 'jpeg' ? 'jpg' : base64Match[1];
    const buffer = Buffer.from(base64Match[2], 'base64');
    const filename = `${id}.${ext}`;
    const filepath = path.join(staticDir, filename);

    fs.writeFileSync(filepath, buffer);

    const url = `http://localhost:${port}/static/${filename}`;
    res.json({ id, url });
  });

  // GET - list all screenshots
  router.get('/', (_req: Request, res: Response) => {
    const files = fs.readdirSync(staticDir)
      .filter((f) => IMAGE_EXTS.some((ext) => f.endsWith(ext)))
      .map((f) => ({
        id: f.replace(/\.(png|jpg|webp)$/, ''),
        url: `http://localhost:${port}/static/${f}`,
      }));
    res.json(files);
  });

  // GET /zip - download all screenshots as a zip archive
  router.get('/zip', (req: Request, res: Response) => {
    interface StepMeta {
      id: string;
      stepNumber: number;
      pageTitle: string;
    }

    let stepsMeta: StepMeta[] = [];
    if (typeof req.query.steps === 'string') {
      try {
        stepsMeta = JSON.parse(req.query.steps);
      } catch {
        // ignore parse errors, fall back to raw filenames
      }
    }

    const files = fs.readdirSync(staticDir)
      .filter((f) => IMAGE_EXTS.some((ext) => f.endsWith(ext)));

    if (files.length === 0) {
      res.status(404).json({ error: 'No screenshots to archive' });
      return;
    }

    // Snapshot file list before streaming so post-zip cleanup only deletes these files
    const filesToClean = [...files];

    const sanitize = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="journey-screenshots.zip"');

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    for (const file of files) {
      const ext = path.extname(file);
      const fileId = file.replace(/\.(png|jpg|webp)$/, '');

      const meta = stepsMeta.find((s) => s.id === fileId);
      const zipName = meta
        ? `step-${meta.stepNumber}-${sanitize(meta.pageTitle)}${ext}`
        : file;

      archive.file(path.join(staticDir, file), { name: zipName });
    }

    // Clean up snapshotted files after zip is fully sent
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      for (const file of filesToClean) {
        try { fs.unlinkSync(path.join(staticDir, file)); } catch { /* already gone */ }
      }
      console.log(`Post-zip cleanup: removed ${filesToClean.length} file(s)`);
    };
    res.on('finish', cleanup);
    res.on('close', cleanup);

    archive.finalize();
  });

  // DELETE - remove all screenshots
  router.delete('/', (_req: Request, res: Response) => {
    cleanAllFiles(staticDir);
    res.json({ ok: true });
  });

  // DELETE - remove a screenshot
  router.delete('/:id', (req: Request, res: Response) => {
    const match = fs.readdirSync(staticDir).find((f) =>
      IMAGE_EXTS.some((ext) => f === `${req.params.id}${ext}`)
    );
    if (match) {
      fs.unlinkSync(path.join(staticDir, match));
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });

  return router;
}
