import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * CacheEntry represents a single cached computation result.
 */
interface CacheEntry {
  /**
   * Input file paths that were processed to create this cache entry.
   * Used to identify which files this cache entry represents.
   * Example: ['scratch/book.xml'] or ['book-to-html.xsl']
   */
  inputPaths: string[];

  /**
   * Content hash of each input file at the time of caching.
   * Primary mechanism for detecting if file content has changed.
   * Even if timestamps lie (git operations, copies), hashes tell the truth.
   * Map: filePath -> SHA256 hash
   */
  inputHashes: Record<string, string>;

  /**
   * Last modified timestamp of each input file at the time of caching.
   * Used for fast invalidation check before expensive hashing.
   * If timestamp unchanged, we skip rehashing (optimization).
   * Map: filePath -> milliseconds since epoch
   */
  inputTimestamps: Record<string, number>;

  /**
   * Output file paths that were generated.
   * Used to verify outputs still exist before claiming cache hit.
   * If user deletes output file, cache must regenerate it.
   * Example: ['scratch/book.html']
   */
  outputPaths: string[];

  /**
   * Upstream dependencies (not direct file inputs) with their paths and hashes.
   * Example: For XsltTransformNode, this includes the compiled stylesheet.
   * When dependencies change, this cache entry is invalidated.
   * Map: dependencyName -> { path: string, hash: string }
   */
  dependencies: Record<string, { path: string; hash: string }>;

  /**
   * When this cache entry was created.
   * Used for debugging ("why did this rebuild?") and potential TTL expiry.
   * Milliseconds since epoch.
   */
  timestamp: number;

  /**
   * The key this entry is stored under.
   * Helps with debugging and cache management.
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
   * Retrieve a cache entry for a specific node and item.
   * Returns null if entry doesn't exist or can't be read.
   */
  async getCache(nodeName: string, itemKey: string): Promise<CacheEntry | null> {
    const cachePath = this.getCachePath(nodeName, itemKey);

    try {
      const content = await fs.readFile(cachePath, 'utf-8');
      return JSON.parse(content) as CacheEntry;
    } catch (error) {
      // Cache miss - file doesn't exist or can't be read
      return null;
    }
  }

  /**
   * Store a cache entry for a specific node and item.
   * Creates necessary directories if they don't exist.
   */
  async setCache(nodeName: string, itemKey: string, entry: CacheEntry): Promise<void> {
    const cachePath = this.getCachePath(nodeName, itemKey);
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
   *
   * Two-tier checking:
   * 1. Check if all output files exist
   * 2. Check if input files changed (timestamp → hash)
   *
   * Returns false if any validation check fails.
   */
  async isValid(entry: CacheEntry): Promise<boolean> {
    // First, verify all output files still exist
    for (const outputPath of entry.outputPaths) {
      try {
        await fs.access(outputPath);
      } catch {
        // Output file missing - cache invalid
        return false;
      }
    }

    // Then check each input file
    for (const inputPath of entry.inputPaths) {
      try {
        const stats = await fs.stat(inputPath);
        const currentTimestamp = stats.mtimeMs;

        // Fast path: If timestamp unchanged, assume content unchanged
        if (currentTimestamp === entry.inputTimestamps[inputPath]) {
          continue;
        }

        // Timestamp changed - need to verify content via hash
        const currentHash = await this.computeFileHash(inputPath);
        if (currentHash !== entry.inputHashes[inputPath]) {
          // Content actually changed
          return false;
        }

        // Timestamp changed but content identical (e.g., touch command)
        // Cache is still valid
      } catch {
        // Input file no longer exists - cache invalid
        return false;
      }
    }

    // Finally, check dependencies haven't changed
    for (const [depName, depInfo] of Object.entries(entry.dependencies)) {
      try {
        const currentHash = await this.computeFileHash(depInfo.path);
        if (currentHash !== depInfo.hash) {
          // Dependency content changed - cache invalid
          return false;
        }
      } catch {
        // Dependency file missing - cache invalid
        return false;
      }
    }

    return true;
  }

  /**
   * Clean up cache entries that are not in the current run.
   * Called at node start to remove orphaned entries for deleted files.
   *
   * Example: If *.xml previously matched 3 files but now matches 2,
   * this removes the cache entry for the deleted file.
   */
  async cleanExcept(nodeName: string, currentItemKeys: string[]): Promise<void> {
    const nodeDir = path.join(this.cacheDir, this.sanitizeNodeName(nodeName));

    try {
      const entries = await fs.readdir(nodeDir);
      const currentKeysSet = new Set(currentItemKeys.map(k => `${this.sanitizeKey(k)}.json`));

      for (const entry of entries) {
        if (!currentKeysSet.has(entry)) {
          // This cache entry is no longer needed
          const orphanPath = path.join(nodeDir, entry);
          await fs.unlink(orphanPath);
        }
      }
    } catch (error) {
      // Node directory doesn't exist yet - nothing to clean
    }
  }

  /**
   * Clear cache for a specific node or all nodes.
   * Useful for manual cache invalidation or debugging.
   */
  async clear(nodeName?: string): Promise<void> {
    if (nodeName) {
      // Clear specific node's cache
      const nodeDir = path.join(this.cacheDir, this.sanitizeNodeName(nodeName));
      try {
        await fs.rm(nodeDir, { recursive: true, force: true });
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
   * Compute SHA256 hash of a file's contents.
   * Used for content-based cache invalidation.
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

    // Create human-readable prefix from first path
    const prefix = paths[0]
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();

    // Combine prefix with hash snippet for uniqueness
    return `${prefix}-${hash.substring(0, 8)}`;
  }

  /**
   * Helper to build a cache entry with all required metadata.
   * Computes hashes and timestamps for all input files.
   */
  async buildCacheEntry(
    inputPaths: string[],
    outputPaths: string[],
    dependencies: Record<string, { path: string; hash: string }>,
    itemKey: string
  ): Promise<CacheEntry> {
    const inputHashes: Record<string, string> = {};
    const inputTimestamps: Record<string, number> = {};

    // Compute hash and timestamp for each input
    for (const inputPath of inputPaths) {
      const [hash, stats] = await Promise.all([
        this.computeFileHash(inputPath),
        fs.stat(inputPath)
      ]);
      inputHashes[inputPath] = hash;
      inputTimestamps[inputPath] = stats.mtimeMs;
    }

    return {
      inputPaths,
      inputHashes,
      inputTimestamps,
      outputPaths,
      dependencies,
      timestamp: Date.now(),
      itemKey
    };
  }

  /**
   * Get the filesystem path for a cache entry.
   */
  private getCachePath(nodeName: string, itemKey: string): string {
    const safeNodeName = this.sanitizeNodeName(nodeName);
    const safeItemKey = this.sanitizeKey(itemKey);
    return path.join(this.cacheDir, safeNodeName, `${safeItemKey}.json`);
  }

  private sanitizeKey(key: string): string {
    // Replace path separators and other problematic chars
    return key
        .replace(/\//g, '-')      // Replace forward slashes
        .replace(/\\/g, '-')      // Replace backslashes
        .replace(/\./g, '_')      // Replace dots (except before extension)
        .replace(/[^a-zA-Z0-9-_]/g, '') // Remove other special chars
        .toLowerCase();
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