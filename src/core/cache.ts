import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * CacheEntry represents a single cached computation result.
 * Uses unified file tracking for all types of dependencies.
 */
interface CacheEntry {
  /**
   * Output file paths organized by output key.
   * Used to verify outputs still exist and reconstruct node outputs.
   * Example: { "transformed": ["scratch/book.html"], "result-documents": ["a.xml", "b.xml"] }
   */
  outputsByKey: Record<string, string[]>;

  /**
   * Base directory for all outputs from this node.
   * Used for cache reconstruction across nodes with different output directories.
   * Example: '.efes-build/transform-epidoc/' or 'dest/'
   */
  outputBaseDir: string;

  /**
   * Unified file tracking - ALL files tracked with same logic.
   * Includes items, fileRefs, and discovered dependencies.
   * Map: filePath -> { hash, timestamp, source }
   */
  trackedFiles: {
    [filePath: string]: {
      hash: string;
      timestamp: number;
      source: 'item' | 'fileRef' | 'discovered' | 'explicit';
    }
  };

  /**
   * Upstream output signatures from `from()` references.
   * Stores both the signature AND the reference spec (outputKey, glob).
   * The signature detects when upstream produces a different set of files.
   * The spec is needed to recompute the signature during validation.
   * Map: nodeName -> { signature, outputKey, glob? }
   */
  upstreamOutputSignatures?: {
    [nodeName: string]: {
      signature: string;
      outputKey: string;
      glob?: string;
    };
  };

  /**
   * When this cache entry was created.
   * Milliseconds since epoch.
   */
  timestamp: number;

  /**
   * The key this entry is stored under.
   * Example: 'book.xml-a3f2b1' or 'stylesheet-compile-2af3e5'
   */
  itemKey: string;
}

/**
 * CacheManager handles persistent caching for pipeline nodes.
 *
 * Two-tier validation strategy:
 * 1. Fast path: Check file timestamps first
 * 2. Accurate path: If timestamps changed, verify content hashes
 *
 * This provides both performance (usually just stat calls) and
 * correctness (hash verification when needed).
 */
export class CacheManager {
  private cacheDir: string;

  constructor(cacheDir: string = '.efes-cache') {
    this.cacheDir = cacheDir;
  }

  /**
   * Retrieve a cache entry for a specific content signature and item.
   * Returns null if entry doesn't exist or can't be read.
   *
   * Note: Considered separate cache entries per requesting node (with node names in filenames)
   * for better debugging provenance, but opted for shared entries with runtime copying to keep
   * the cache simple and avoid file duplication. This decision could be revisited if debugging
   * benefits outweigh the architectural simplicity.
   */
  async getCache(contentSignature: string, itemKey: string): Promise<CacheEntry | null> {
    const cachePath = this.getCachePath(contentSignature, itemKey);

    try {
      const content = await fs.readFile(cachePath, 'utf-8');
      return JSON.parse(content) as CacheEntry;
    } catch (error) {
      // Cache miss - file doesn't exist or can't be read
      return null;
    }
  }

  /**
   * Store a cache entry for a specific content signature and item.
   * Creates necessary directories if they don't exist.
   */
  async setCache(contentSignature: string, itemKey: string, entry: CacheEntry): Promise<void> {
    const cachePath = this.getCachePath(contentSignature, itemKey);
    const cacheNodeDir = path.dirname(cachePath);

    // Ensure cache directory exists
    await fs.mkdir(cacheNodeDir, { recursive: true });

    // Store with pretty printing for human readability
    await fs.writeFile(
      cachePath,
      JSON.stringify(entry, null, 2),
      'utf-8'
    );
  }

  /**
   * Validate if a cache entry is still valid.
   * Uses unified validation for all tracked files.
   *
   * Four-tier checking (ordered from cheapest to most expensive):
   * 1. Upstream output signatures - detect if upstream produces different file set
   * 2. Tracked file timestamps - fast stat() calls
   * 3. Tracked file hashes - only if timestamps changed
   * 4. Output existence - verify all outputs still exist
   *
   * Returns false if any validation check fails.
   */
  async isValid(
    entry: CacheEntry,
    context?: {
      getNodeOutputs: (nodeName: string) => any[] | undefined;
      resolveInput?: (input: any) => Promise<string[]>;
    }
  ): Promise<boolean> {
    // 1. Check upstream output signatures (cheapest - string comparison)
    if (entry.upstreamOutputSignatures && context?.resolveInput) {
      for (const [nodeName, upstreamInfo] of Object.entries(entry.upstreamOutputSignatures)) {
        // Reconstruct the NodeOutputReference from stored metadata
        const nodeRef = {
          node: { name: nodeName },
          name: upstreamInfo.outputKey,
          glob: upstreamInfo.glob,
          type: 'node-output-reference' as const
        };

        let currentPaths: string[];
        try {
          // Use resolveInput to get the correctly filtered paths (same as during storage)
          currentPaths = await context.resolveInput(nodeRef);
        } catch (error) {
          return false; // Upstream node hasn't run yet or error occurred
        }

        const currentSignature = CacheManager.computeOutputSignature(currentPaths);
        if (currentSignature !== upstreamInfo.signature) {
          return false; // Upstream produced different file set
        }
      }
    }

    // 2. Check ALL tracked files with unified logic (timestamps first, then hashes)
    for (const [filePath, fileInfo] of Object.entries(entry.trackedFiles)) {
      try {
        const stats = await fs.stat(filePath);

        // Fast path: mtime shortcut
        if (stats.mtimeMs === fileInfo.timestamp) {
          continue; // Unchanged
        }

        // Slow path: verify content
        const currentHash = await this.computeFileHash(filePath);
        if (currentHash !== fileInfo.hash) {
          return false; // Content changed
        }
        // Timestamp changed but content identical - still valid
      } catch (err) {
        console.log(`[CACHE DEBUG] File missing or inaccessible: ${filePath}`);
        return false; // File missing
      }
    }

    // 3. Check all output files exist (moved to end - if dependencies valid, outputs usually exist)
    for (const paths of Object.values(entry.outputsByKey)) {
      for (const outputPath of paths) {
        try {
          await fs.access(outputPath);
        } catch {
          return false; // Output missing
        }
      }
    }

    return true;
  }

  /**
   * Compute a signature hash from a list of file paths.
   * Used for tracking upstream output sets.
   */
  static computeOutputSignature(filePaths: string[]): string {
    const sorted = [...filePaths].sort();
    const combined = sorted.join('|');
    return crypto.createHash('sha256').update(combined).digest('hex').substring(0, 16);
  }

  /**
   * Clean up cache entries that are not in the current run.
   * Called at node start to remove orphaned entries for deleted files.
   *
   * Example: If *.xml previously matched 3 files but now matches 2,
   * this removes the cache entry for the deleted file.
   */
  async cleanExcept(contentSignature: string, currentItemKeys: string[]): Promise<void> {
    const signatureDir = path.join(this.cacheDir, this.sanitizeNodeName(contentSignature));

    try {
      const entries = await fs.readdir(signatureDir);
      const currentKeysSet = new Set(currentItemKeys.map(k => `${this.sanitizeKey(k)}.json`));

      for (const entry of entries) {
        if (!currentKeysSet.has(entry)) {
          // This cache entry is no longer needed
          const orphanPath = path.join(signatureDir, entry);
          await fs.unlink(orphanPath);
        }
      }
    } catch (error) {
      // Signature directory doesn't exist yet - nothing to clean
    }
  }

  /**
   * Clear cache for a specific content signature or all cache.
   * Useful for manual cache invalidation or debugging.
   */
  async clear(contentSignature?: string): Promise<void> {
    if (contentSignature) {
      // Clear specific signature's cache
      const signatureDir = path.join(this.cacheDir, this.sanitizeNodeName(contentSignature));
      try {
        await fs.rm(signatureDir, { recursive: true, force: true });
      } catch {
        // Directory doesn't exist - already clear
      }
    } else {
      // Clear entire cache
      try {
        await fs.rm(this.cacheDir, { recursive: true, force: true });
      } catch {
        // Cache directory doesn't exist - already clear
      }
    }
  }

  /**
   * Copy a cached output file to the expected build path when cache is shared
   * between nodes with different output paths.
   */
  async copyToExpectedPath(sourcePath: string, expectedPath: string): Promise<void> {
    // Ensure destination directory exists
    await fs.mkdir(path.dirname(expectedPath), { recursive: true });

    // Copy the cached file to expected location
    await fs.copyFile(sourcePath, expectedPath);
  }

  /**
   * Compute SHA256 hash of a file's contents.
   * Used for content-based cache invalidation.
   * Public so that callers can pre-compute hashes for batch operations.
   */
  async computeFileHash(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    const hash = crypto.createHash('sha256');
    hash.update(content);
    return hash.digest('hex');
  }

  /**
   * Generate a consistent cache key from file paths.
   * Used to create deterministic, filesystem-safe cache keys.
   *
   * Example: makeItemKey('scratch/book.xml') → 'scratch-book-xml-a3f2b1'
   */
  static makeItemKey(...paths: string[]): string {
    // Combine paths and hash them for a unique, consistent key
    const combined = paths.sort().join('|');
    const hash = crypto.createHash('sha256').update(combined).digest('hex');

    // Create human-readable prefix from first path (use basename to avoid long paths)
    const basename = path.basename(paths[0]);
    const prefix = basename
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .substring(0, 50); // Limit prefix length

    // Combine prefix with hash snippet for uniqueness
    return `${prefix}-${hash.substring(0, 8)}`;
  }

  /**
   * Helper to build a cache entry with unified file tracking.
   * Computes hashes and timestamps for all files with same logic.
   * @param precomputedHashes - Optional map of pre-computed hashes for shared dependencies (fileRefs)
   */
  async buildCacheEntry(
    itemPaths: string[],
    outputsByKey: Record<string, string[]>,
    outputBaseDir: string,
    itemKey: string,
    discoveredDependencies?: string[],
    fileRefPaths?: string[],
    upstreamOutputSignatures?: {
      [nodeName: string]: {
        signature: string;
        outputKey: string;
        glob?: string;
      };
    },
    precomputedHashes?: Map<string, {hash: string, timestamp: number}>
  ): Promise<CacheEntry> {
    const trackedFiles: Record<string, {hash: string, timestamp: number, source: 'item' | 'fileRef' | 'discovered' | 'explicit'}> = {};

    // Track items
    for (const filePath of itemPaths) {
      try {
        const [hash, stats] = await Promise.all([
          this.computeFileHash(filePath),
          fs.stat(filePath)
        ]);
        trackedFiles[filePath] = { hash, timestamp: stats.mtimeMs, source: 'item' };
      } catch {
        // Skip missing files
      }
    }

    // Track fileRefs - use precomputed hashes (passed by caller to avoid redundant hashing)
    if (fileRefPaths && precomputedHashes) {
      for (const filePath of fileRefPaths) {
        const precomputed = precomputedHashes.get(filePath);
        if (precomputed) {
          // Use precomputed hash (avoids re-hashing same stylesheet 2360 times)
          trackedFiles[filePath] = { ...precomputed, source: 'fileRef' };
        }
        // If not precomputed, skip it (caller should have precomputed all fileRefs)
      }
    }

    // Track discovered dependencies
    if (discoveredDependencies) {
      for (const filePath of discoveredDependencies) {
        try {
          const [hash, stats] = await Promise.all([
            this.computeFileHash(filePath),
            fs.stat(filePath)
          ]);
          trackedFiles[filePath] = { hash, timestamp: stats.mtimeMs, source: 'discovered' };
        } catch {
          // Skip missing discovered dependencies
        }
      }
    }

    return {
      outputsByKey,
      outputBaseDir,
      trackedFiles,
      upstreamOutputSignatures,
      timestamp: Date.now(),
      itemKey
    };
  }

  /**
   * Get the filesystem path for a cache entry.
   */
  private getCachePath(contentSignature: string, itemKey: string): string {
    const safeSignature = this.sanitizeNodeName(contentSignature);
    const safeItemKey = this.sanitizeKey(itemKey);
    return path.join(this.cacheDir, safeSignature, `${safeItemKey}.json`);
  }

  private sanitizeKey(key: string): string {
    // Replace path separators and other problematic chars
    const sanitized = key
        .replace(/\//g, '-')      // Replace forward slashes
        .replace(/\\/g, '-')      // Replace backslashes
        .replace(/\./g, '_')      // Replace dots (except before extension)
        .replace(/[^a-zA-Z0-9-_]/g, '') // Remove other special chars
        .toLowerCase();

    // Limit filename length to avoid filesystem limits (255 chars - some buffer for .json extension)
    return sanitized.length > 200 ? sanitized.substring(0, 200) : sanitized;
  }

  /**
   * Sanitize node name for use as directory name.
   * Ensures filesystem compatibility across platforms.
   */
  private sanitizeNodeName(nodeName: string): string {
    return nodeName
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase();
  }
}