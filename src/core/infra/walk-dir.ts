import { readdir } from "node:fs/promises";
import path from "node:path";

export interface WalkDirEntry {
  name: string;
  relativePath: string;
  fullPath: string;
  isDirectory: boolean;
}

export interface WalkDirContext {
  /** Depth of the directory currently being listed (root = 0). */
  depth: number;
  visited: number;
  stop(): void;
}

export interface WalkDirOptions {
  /** Directory entry names to skip (not descended into). */
  skipDirs?: ReadonlySet<string>;
  /** Skip entries whose name starts with ".". */
  skipDotEntries?: boolean;
  /** Maximum depth of directories to list (root = 0). */
  maxDepth?: number;
  /** Stop after collecting this many file paths. */
  maxFiles?: number;
  /** Stop after visiting this many entries (files and directories). */
  maxVisited?: number;
  /** Return paths relative to root instead of absolute paths. */
  relativePaths?: boolean;
  /** Sort each directory's entries by name before visiting. */
  sortEntries?: boolean;
  /** Include directories in the returned paths. */
  includeDirectories?: boolean;
  /** Include only files matching this filter. */
  fileFilter?: (entry: WalkDirEntry) => boolean;
  /** Invoked for each visited entry. Return false to skip descending into a directory. */
  onEntry?: (entry: WalkDirEntry, context: WalkDirContext) => boolean | void;
}

export interface WalkDirResult {
  paths: string[];
  visited: number;
  stoppedEarly: boolean;
}

export async function walkDir(root: string, options: WalkDirOptions = {}): Promise<string[]> {
  return (await walkDirDetailed(root, options)).paths;
}

export async function walkDirDetailed(root: string, options: WalkDirOptions = {}): Promise<WalkDirResult> {
  const resolvedRoot = path.resolve(root);
  const paths: string[] = [];
  let visited = 0;
  let stoppedEarly = false;

  const {
    skipDirs = new Set<string>(),
    skipDotEntries = false,
    maxDepth = Number.POSITIVE_INFINITY,
    maxFiles = Number.POSITIVE_INFINITY,
    maxVisited = Number.POSITIVE_INFINITY,
    relativePaths = false,
    sortEntries = false,
    includeDirectories = false,
    fileFilter,
    onEntry
  } = options;

  const context: WalkDirContext = {
    depth: 0,
    visited: 0,
    stop() {
      stoppedEarly = true;
    }
  };

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (stoppedEarly || depth > maxDepth || visited >= maxVisited || paths.length >= maxFiles) {
      stoppedEarly = true;
      return;
    }

    context.depth = depth;
    context.visited = visited;

    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    if (sortEntries) {
      entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    for (const dirent of entries) {
      if (stoppedEarly || visited >= maxVisited || paths.length >= maxFiles) {
        stoppedEarly = true;
        return;
      }

      const name = dirent.name;
      if (skipDotEntries && name.startsWith(".")) continue;
      if (skipDirs.has(name)) continue;

      const fullPath = path.join(currentDir, name);
      const relativePath = path.relative(resolvedRoot, fullPath);
      const isDirectory = dirent.isDirectory();
      const entry: WalkDirEntry = { name, relativePath, fullPath, isDirectory };

      visited += 1;
      context.visited = visited;

      let descend = isDirectory;
      if (onEntry) {
        const result = onEntry(entry, context);
        if (result === false) descend = false;
        if (stoppedEarly) return;
      }

      if (isDirectory) {
        if (includeDirectories && (!fileFilter || fileFilter(entry))) {
          paths.push(relativePaths ? relativePath : fullPath);
          if (paths.length >= maxFiles) {
            stoppedEarly = true;
            return;
          }
        }
        if (descend) {
          await walk(fullPath, depth + 1);
        }
      } else if (!fileFilter || fileFilter(entry)) {
        paths.push(relativePaths ? relativePath : fullPath);
        if (paths.length >= maxFiles) {
          stoppedEarly = true;
          return;
        }
      }
    }
  }

  await walk(resolvedRoot, 0);
  return { paths, visited, stoppedEarly };
}