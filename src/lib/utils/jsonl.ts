import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function appendJsonl<T>(path: string, record: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const body = await readFile(path, 'utf8');
    const lines = body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.flatMap((line, index) => {
      try {
        return [JSON.parse(line) as T];
      } catch (error) {
        const isLastUnterminatedLine = index === lines.length - 1 && !body.endsWith('\n');
        if (isLastUnterminatedLine) return [];
        throw error;
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
