import {DepGraph} from "dependency-graph";
import {CacheManager} from "./cache";
import {glob} from "glob";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import {fileURLToPath} from "node:url";
import {WorkerPool} from "../xml/workerPool";

interface NodeOutputReference {
    node: PipelineNode<any, any>;
    name: string;
    glob?: string;  // Optional glob pattern to filter output files
}

export function inputIsNodeOutputReference(input: Input): input is NodeOutputReference {
    return typeof input === 'object' && 'node' in input && 'name' in input;
}

export type Input = string | string[] | NodeOutputReference;
export type NodeOutput<TKey extends string> = Record<TKey, string[]>;

// File reference type for tracking dependencies in config
export type FileRef = { type: 'file', path: string };

export function from<TNode extends PipelineNode<any, TOutput>, TOutput extends string>(
    node: TNode,
    output: TOutput,
    glob?: string
): NodeOutputReference {
    return {node, name: output as string, glob};
}

export function fileRef(path: string): FileRef {
    return { type: 'file', path };
}

/**
 * Unified output configuration for all node types.
 * Provides smart defaults and escape hatches for common path manipulation patterns.
 */
export interface UnifiedOutputConfig {
    // LOCATION: Where files go
    /** Output directory. Default: buildDir/nodeName */
    outputDir?: string;

    // STRUCTURE: Path manipulation (evaluated in order, pick one)
    /** Flatten to just basename (filename with extension) */
    flattenToBasename?: boolean;
    /** Strip this prefix from the path */
    stripPathPrefix?: string;
    /** Full custom path transformation (receives clean path after build prefix stripped) */
    pathMapping?: (cleanPath: string) => string;
    // Default: preserve full path

    // NAMING: Filename changes
    /** Override entire output filename (string or function) */
    outputFilename?: string | ((inputPath: string) => string);
    /** Change file extension (e.g., '.html', '.json') */
    extension?: string;
    /** Add suffix before extension (e.g., '-processed') */
    filenameSuffix?: string;
    // Default: preserve original filename (or change ext for transforms)
}

export interface PipelineNodeConfig {
    name: string;
    // Processing configuration (may contain Input values via FileRef or from())
    config: Record<string, any>;
    // Output settings (excluded from content signature)
    outputConfig?: Record<string, any>;
    explicitDependencies?: string[];
}


export abstract class PipelineNode<TConfig extends PipelineNodeConfig = PipelineNodeConfig, TOutput extends string = string> {
    constructor(public readonly config: TConfig) {
    }

    get name() {
        return this.config.name;
    }

    /**
     * Log a message with the node name prepended.
     */
    protected log(context: PipelineContext, message: string): void {
        context.log(`  [${this.name}] ${message}`);
    }

    /**
     * Optional lifecycle hook called when this node is added to a pipeline.
     * Composite nodes can use this to expand their internal nodes.
     */
    onAddedToPipeline?(pipeline: Pipeline): void;

    abstract run(context: PipelineContext): Promise<NodeOutput<TOutput>[]>;

    /**
     * Generate a content signature for this node based on its configuration.
     * Nodes with identical signatures can share cache entries.
     * Uses file paths (stable) instead of content hashes (changing) to prevent cache pollution.
     */
    /**
     * Helper: Get relative path from item, stripping build prefixes if present.
     * Used for outputDir-based path calculation.
     * @deprecated Use calculateOutputPath instead
     */
    protected getCleanRelativePath(item: string, context: PipelineContext): string {
        const itemDir = path.dirname(item);
        const cleanDir = context.stripBuildPrefix(itemDir);
        return path.relative(process.cwd(), cleanDir);
    }

    /**
     * Calculate output path for a given input path using unified config.
     * Handles build prefix stripping, path manipulation, and filename changes.
     *
     * @param inputPath - Input file path
     * @param context - Pipeline context
     * @param outputConfig - Unified output configuration
     * @param defaultExtension - Default extension for this node type (optional)
     * @returns Final output path
     */
    protected calculateOutputPath(
        inputPath: string,
        context: PipelineContext,
        outputConfig: UnifiedOutputConfig,
        defaultExtension?: string
    ): string {
        // Step 1: Strip build prefix to get clean path
        const cleanPath = context.stripBuildPrefix(inputPath);

        // Step 2: Apply path structure manipulation
        let processedPath: string;

        if (outputConfig.flattenToBasename) {
            // Just basename (filename with extension)
            processedPath = path.basename(cleanPath);
        } else if (outputConfig.stripPathPrefix) {
            // Strip specific prefix from path
            const prefix = outputConfig.stripPathPrefix;
            const normalizedClean = cleanPath.split(path.sep).join('/');
            const normalizedPrefix = prefix.split(path.sep).join('/');

            if (normalizedClean.startsWith(normalizedPrefix)) {
                const stripped = normalizedClean.substring(normalizedPrefix.length);
                processedPath = stripped.startsWith('/') ? stripped.substring(1) : stripped;
            } else {
                processedPath = cleanPath;
            }
        } else if (outputConfig.pathMapping) {
            // Custom path transformation
            processedPath = outputConfig.pathMapping(cleanPath);
        } else {
            // Default: preserve full path
            processedPath = cleanPath;
        }

        // Step 3: Apply filename changes
        let finalFilename: string;

        if (outputConfig.outputFilename) {
            // Override entire filename
            if (typeof outputConfig.outputFilename === 'function') {
                finalFilename = outputConfig.outputFilename(inputPath);
            } else {
                finalFilename = outputConfig.outputFilename;
            }
        } else {
            // Apply extension and/or suffix changes
            const dir = path.dirname(processedPath);
            const basename = path.basename(processedPath);
            const ext = path.extname(basename);
            const nameWithoutExt = path.basename(basename, ext);

            const newExt = outputConfig.extension ?? defaultExtension ?? ext;
            const suffix = outputConfig.filenameSuffix ?? '';

            const newBasename = `${nameWithoutExt}${suffix}${newExt}`;
            finalFilename = dir === '.' ? newBasename : path.join(dir, newBasename);
        }

        // Step 4: Combine with output directory
        const outputDir = outputConfig.outputDir ?? context.getBuildPath(this.name, '');
        return path.join(outputDir, finalFilename);
    }

    /**
     * Serialize a value (without key prefix) for content signature.
     * Recursive helper for serializeForSignature.
     */
    private serializeValue(value: any, path: string): string {
        // Null/undefined
        if (value === null || value === undefined) {
            return 'null';
        }

        // FileRef - use relative path
        if (value?.type === 'file') {
            return `FileRef(${value.path})`;
        }

        // from() reference - use logical reference
        if (inputIsNodeOutputReference(value)) {
            const globPart = value.glob ? `:${value.glob}` : '';
            return `from(${value.node.name}:${value.name}${globPart})`;
        }

        // Functions - use toString()
        if (typeof value === 'function') {
            return value.toString();
        }

        // Plain primitives
        if (typeof value !== 'object') {
            return JSON.stringify(value);
        }

        // Arrays - recursively serialize elements
        if (Array.isArray(value)) {
            const elements = value.map((v, i) => this.serializeValue(v, `${path}[${i}]`));
            return `[${elements.join(',')}]`;
        }

        // Plain objects - recursively serialize properties
        const entries = Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}:${this.serializeValue(v, `${path}.${k}`)}`);
        return `{${entries.join(',')}}`;
    }

    /**
     * Serialize a config key-value pair for inclusion in content signature.
     * Throws if encountering unknown object types to ensure we handle all cases.
     *
     * TODO: Move config validation logic to a central location, not tied to signature generation.
     * This would allow validating configs at node construction time rather than during execution.
     */
    private serializeForSignature(key: string, value: any): string | null {
        if (value === null || value === undefined) {
            return null;
        }

        const serializedValue = this.serializeValue(value, key);
        return `${key}:${serializedValue}`;
    }

    protected async getContentSignature(context: PipelineContext): Promise<string> {
        const configParts: string[] = [];

        // Serialize all config values
        for (const [key, value] of Object.entries(this.config.config || {})) {
            const serialized = this.serializeForSignature(key, value);
            if (serialized) {
                configParts.push(serialized);
            }
        }

        // Combine all parts, sort for consistency, and hash
        const combined = configParts.sort().join('|');
        const hash = crypto.createHash('sha256').update(combined).digest('hex');

        return `${this.constructor.name}-${hash.substring(0, 8)}`;
    }

    // Unified caching for single or multiple items
    protected async withCache<TOutput extends string>(
        context: PipelineContext,
        items: string[],
        getCacheKey: (item: string) => string,
        getOutputDir: () => string,
        getOutputPath: (item: string, outputKey: TOutput, filename?: string) => string | undefined,
        performWork: (item: string) => Promise<{
            outputs: Record<TOutput, string[]>;
            discoveredDependencies?: string[];
        }>
    ): Promise<Array<{ item: string, outputs: NodeOutput<TOutput>, cached: boolean }>> {
        const contentSignature = await this.getContentSignature(context);

        // Extract fileRef paths and resolve from() references for cache entries
        const configDependencyPaths: string[] = [];
        const upstreamNodes = new Map<string, NodeOutputReference>(); // Track upstream node references

        const processConfigValue = async (value: any) => {
            if (value?.type === 'file') {
                // FileRef - extract path directly
                configDependencyPaths.push(value.path);
            } else if (inputIsNodeOutputReference(value)) {
                // from() reference - resolve to file paths AND track upstream node
                const resolvedPaths = await context.resolveInput(value);
                configDependencyPaths.push(...resolvedPaths);
                upstreamNodes.set(value.node.name, value);
            } else if (typeof value === 'object') {
                // Recursively process object values
                for (const v of Object.values(value)) {
                    await processConfigValue(v);
                }
            }
        };

        for (const value of Object.values(this.config.config || {})) {
            await processConfigValue(value);
        }

        // Compute upstream output signatures with metadata
        const upstreamOutputSignatures: {
            [nodeName: string]: {
                signature: string;
                outputKey: string;
                glob?: string;
            };
        } = {};
        for (const [nodeName, nodeRef] of upstreamNodes.entries()) {
            const outputs = await context.resolveInput(nodeRef);
            const signature = CacheManager.computeOutputSignature(outputs);
            upstreamOutputSignatures[nodeName] = {
                signature,
                outputKey: nodeRef.name,
                glob: nodeRef.glob
            };
        }


        const cacheKeys = items.map(getCacheKey);
        context.log(`Cache lookup - contentSignature: ${contentSignature}`);
        // await context.cache.cleanExcept(contentSignature, cacheKeys);

        // Pre-compute hashes for shared dependencies (fileRefs) - these are the same for all items
        // Avoids hashing the same stylesheet 2360 times
        const sharedFileHashes = new Map<string, {hash: string, timestamp: number}>();
        if (configDependencyPaths.length > 0) {
            context.log(`Pre-computing hashes for ${configDependencyPaths.length} shared dependencies`);
            await Promise.all(configDependencyPaths.map(async (filePath) => {
                try {
                    const [hash, stats] = await Promise.all([
                        context.cache.computeFileHash(filePath),
                        fs.stat(filePath)
                    ]);
                    sharedFileHashes.set(filePath, { hash, timestamp: stats.mtimeMs });
                } catch {
                    // File doesn't exist, skip
                }
            }));
        }

        // NOTE: Cache validation could be parallelized with Promise.all() for potential speedup
        // on workloads with high cache hit rates (80%+) and slow I/O. However, testing showed
        // that for typical workloads (low cache hit rate, fast SSD), the Promise coordination
        // overhead outweighs benefits. Parallelizing the actual work (via worker threads) is
        // more impactful than parallelizing cache validation.

        // Phase 1: Cache validation (sequential) - identify cache hits and misses
        const results = [];
        const cacheMisses: Array<{item: string, cacheKey: string, index: number}> = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const cacheKey = cacheKeys[i];

            const cached = await context.cache.getCache(contentSignature, cacheKey);
            if (!cached) {
                // context.log(`  - Cache miss for ${item}: no cache entry found (key: ${cacheKey.substring(0, 50)}...)`);
                cacheMisses.push({item, cacheKey, index: i});
                results[i] = null; // Placeholder
                continue;
            }

            // Recalculate expected paths based on CURRENT config
            const cachedBaseDir = cached.outputBaseDir;
            const newBaseDir = getOutputDir();
            const newOutputsByKey: Record<TOutput, string[]> = {} as Record<TOutput, string[]>;

            for (const [outputKey, cachedPaths] of Object.entries(cached.outputsByKey)) {
                // Try to recalculate path using current config
                const recalculatedPath = getOutputPath(item, outputKey as TOutput);

                if (recalculatedPath !== undefined) {
                    // Can recalculate (primary outputs) - use current config
                    newOutputsByKey[outputKey as TOutput] = [recalculatedPath];
                } else {
                    // Can't recalculate (secondary outputs) - reconstruct from cached structure
                    const newPaths: string[] = [];
                    for (const cachedPath of cachedPaths) {
                        // Extract relative path from cached base directory
                        const relativePath = path.relative(cachedBaseDir, cachedPath);

                        // Validate: ensure path doesn't escape (no ../ at start)
                        if (relativePath.startsWith('..')) {
                            throw new Error(`Cached output path escapes base directory: ${cachedPath} (base: ${cachedBaseDir})`);
                        }

                        // Reconstruct path in new base directory
                        const expectedPath = path.join(newBaseDir, relativePath);
                        newPaths.push(expectedPath);
                    }
                    newOutputsByKey[outputKey as TOutput] = newPaths;
                }
            }

            // Validate dependencies (regardless of where outputs currently are)
            const dependenciesValid = await context.cache.isValid(cached, context);

            if (!dependenciesValid) {
                // context.log(`  - Cache miss for ${item}: dependencies changed`);
                cacheMisses.push({item, cacheKey, index: i});
                results[i] = null; // Placeholder
            } else {
                // Copy files if needed (cross-node reuse)
                // TODO: Could optimize by checking if file already exists at expectedPath with same hash
                for (const [outputKey, cachedPaths] of Object.entries(cached.outputsByKey)) {
                    const expectedPaths = newOutputsByKey[outputKey as TOutput];
                    for (let i = 0; i < cachedPaths.length; i++) {
                        const cachedPath = cachedPaths[i];
                        const expectedPath = expectedPaths[i];
                        if (cachedPath !== expectedPath) {
                            // Cross-node reuse - copy to expected location
                            await context.cache.copyToExpectedPath(cachedPath, expectedPath);
                        }
                    }
                }

                context.log(`  - Skipping: ${item} (cached)`);
                results[i] = {item, outputs: newOutputsByKey, cached: true};
            }
        }

        // Phase 2: Work execution (parallel) - process all cache misses concurrently
        if (cacheMisses.length > 0) {
            context.log(`Processing ${cacheMisses.length} cache misses`);
            const workPromises = cacheMisses.map(async ({item, cacheKey, index}) => {
                const processed = await performWork(item);

                // Build unified cache entry (using pre-computed shared hashes)
                const cacheEntry = await context.cache.buildCacheEntry(
                    [item],                    // Item files
                    processed.outputs,         // Output files by key
                    getOutputDir(),            // Output base directory
                    cacheKey,                  // Cache key
                    processed.discoveredDependencies,    // Discovered dependencies
                    configDependencyPaths,     // Config dependencies (FileRefs + resolved from() references)
                    upstreamOutputSignatures,  // Upstream node output signatures
                    sharedFileHashes           // Pre-computed hashes for shared dependencies
                );

                return {index, item, processed, cacheEntry, cacheKey};
            });

            context.log(`Awaiting completion of ${workPromises.length} work items`);
            const processedItems = await Promise.all(workPromises);
            context.log(`Work completed, storing ${processedItems.length} cache entries`);

            // Phase 3: Cache storage (parallel) - save cache entries
            await Promise.all(processedItems.map(async ({index, item, processed, cacheEntry, cacheKey}) => {
                await context.cache.setCache(contentSignature, cacheKey, cacheEntry);
                results[index] = {item, outputs: processed.outputs, cached: false};
            }));
            context.log(`Cache storage complete`);
        }

        return results.filter(r => r !== null);
    }
}

export interface PipelineContext {
    resolveInput(input: Input): Promise<string[]>;

    log(message: string): void;

    cache: CacheManager;
    buildDir: string;
    workerPool: WorkerPool;

    getBuildPath(nodeName: string, inputPath: string, newExtension?: string): string;
    stripBuildPrefix(inputPath: string): string;
    getNodeOutputs(nodeName: string): NodeOutput<any>[] | undefined;
}

export class Pipeline {
    private graph = new DepGraph<PipelineNode>();
    private nodeOutputs = new Map<string, NodeOutput<any>[]>;
    private nodeTimings = new Map<string, number>();
    private cache: CacheManager;
    private workerPool: WorkerPool;

    constructor(
        public readonly name: string,
        public readonly buildDir: string = '.efes-build',
        public readonly cacheDir: string = '.efes-cache',
        public readonly executionMode: 'sequential' | 'parallel' | 'dynamic' = 'sequential'
    ) {
        this.cache = new CacheManager(cacheDir);

        // Create shared worker pool with generic worker
        const currentDir = path.dirname(fileURLToPath(import.meta.url));
        const devPath = path.resolve(currentDir, '../xml/genericWorker.ts');
        const prodPath = path.resolve(currentDir, 'genericWorker.js');
        const workerPath = fsSync.existsSync(prodPath) ? prodPath : devPath;

        this.workerPool = new WorkerPool(8, workerPath);
    }

    addNode(...nodes: PipelineNode<any, any>[]): this {
        for (const node of nodes) {
            this.graph.addNode(node.name, node);

            // Call lifecycle hook if it exists
            if (node.onAddedToPipeline) {
                node.onAddedToPipeline(this);
            }
        }

        return this;
    }

    // TODO probably useless
    addExplicitDependency(fromNodeName: string, toNodeName: string): this {
        // Validate that both nodes exist
        if (!this.graph.hasNode(fromNodeName)) {
            throw new Error(`Node "${fromNodeName}" not found in pipeline`);
        }
        if (!this.graph.hasNode(toNodeName)) {
            throw new Error(`Node "${toNodeName}" not found in pipeline`);
        }

        // Add to the node's explicit dependencies config
        const node = this.graph.getNodeData(fromNodeName);
        if (!node.config.explicitDependencies) {
            node.config.explicitDependencies = [];
        }
        if (!node.config.explicitDependencies.includes(toNodeName)) {
            node.config.explicitDependencies.push(toNodeName);
        }

        return this;
    }

    private setupExplicitDependencies() {
        // Setup explicit dependencies first
        for (const nodeName of this.graph.overallOrder()) {
            const node = this.graph.getNodeData(nodeName);

            // Handle explicit dependencies only
            if (node.config.explicitDependencies) {
                for (const depNodeName of node.config.explicitDependencies) {
                    try {
                        // Validate that the dependency node exists
                        if (!this.graph.hasNode(depNodeName)) {
                            throw new Error(`Explicit dependency "${depNodeName}" not found in pipeline`);
                        }
                        console.log(`Adding explicit dependency for node ${node.name}: ${depNodeName}`);
                        this.graph.addDependency(node.name, depNodeName);
                    } catch (err: any) {
                        throw new Error(`Failed to add explicit dependency for node ${node.name}: ${err.message}`);
                    }
                }
            }
        }
    }

    private setupAutomaticDependencies() {
        // Setup automatic dependencies from NodeOutputReferences in items and config
        for (const nodeName of this.graph.overallOrder()) {
            const node = this.graph.getNodeData(nodeName);

            // Check items field for NodeOutputReference
            if (node.items && inputIsNodeOutputReference(node.items)) {
                try {
                    // console.log(`Adding automatic dependency for node ${node.name}: ${node.items.node.name} (from items)`);
                    this.graph.addDependency(node.name, node.items.node.name);
                } catch (err: any) {
                    throw new Error(`Failed to add automatic dependency for node ${node.name}: ${err.message}`);
                }
            }

            // Recursively check config for NodeOutputReferences
            if (node.config) {
                const findNodeReferences = (obj: any, path: string = 'config') => {
                    if (inputIsNodeOutputReference(obj)) {
                        try {
                            // console.log(`Adding automatic dependency for node ${node.name}: ${obj.node.name} (from ${path})`);
                            this.graph.addDependency(node.name, obj.node.name);
                        } catch (err: any) {
                            throw new Error(`Failed to add automatic dependency for node ${node.name}: ${err.message}`);
                        }
                    } else if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                        // Recursively search nested objects
                        for (const [key, value] of Object.entries(obj)) {
                            findNodeReferences(value, `${path}.${key}`);
                        }
                    }
                };

                findNodeReferences(node.config);
            }
        }
    }

    async run() {
        const pipelineStart = performance.now();
        console.log(`Running pipeline ${this.name}`);
        console.log(`Number of nodes: ${this.graph.size()}`);

        // Setup explicit dependencies
        this.setupExplicitDependencies();

        // Setup automatic dependencies from NodeOutputReferences
        this.setupAutomaticDependencies();

        // Track currently running nodes for supervisor
        const runningNodes = new Set<string>();

        const executionOrder = this.graph.overallOrder();

        // Start supervisor that logs running nodes every 5 seconds
        const supervisorInterval = setInterval(() => {
            if (runningNodes.size > 0) {
                const activeWorkers = this.workerPool.getActiveWorkers();
                console.log(`\n[Supervisor] Currently running ${runningNodes.size} node(s), ${activeWorkers.size} worker(s) busy:`);
                for (const nodeName of runningNodes) {
                    console.log(`  ⏳ ${nodeName}`);
                }
                if (activeWorkers.size > 0) {
                    console.log(`  Workers:`);
                    for (const [workerId, job] of activeWorkers.entries()) {
                        // Extract node name and file being processed
                        const nodeName = job.nodeName || 'unknown';
                        const fileName = job.xsltPath ? path.basename(job.xsltPath) :
                                        job.sourcePath ? path.basename(job.sourcePath) :
                                        'unknown';
                        console.log(`    Worker ${workerId}: [${nodeName}] ${fileName}`);
                    }
                }
            }
        }, 5000);

        // Cache for resolveInput to avoid redundant glob operations during cache validation
        const resolveInputCache = new Map<string, Promise<string[]>>();

        const context: PipelineContext = {
            resolveInput: async (input: Input): Promise<string[]> => {
                // Create a cache key from the input
                const cacheKey = JSON.stringify(input, (key, value) => {
                    // Handle NodeOutputReference specially to create stable keys
                    if (value && typeof value === 'object' && 'node' in value && 'name' in value) {
                        return `NodeRef:${value.node.name}:${value.name}:${value.glob || ''}`;
                    }
                    return value;
                });

                // Check cache first
                const cached = resolveInputCache.get(cacheKey);
                if (cached) {
                    return cached;
                }

                // Compute and cache the result (cache the promise to handle concurrent calls)
                const resultPromise = this.resolveInputImpl(input);
                resolveInputCache.set(cacheKey, resultPromise);
                return resultPromise;
            },
            log: (message: string) => console.log(`  [${this.name}] ${message}`),
            cache: this.cache,
            buildDir: this.buildDir,
            workerPool: this.workerPool,
            getBuildPath: (nodeName: string, inputPath: string, newExtension?: string): string => {
                let relativePath = inputPath;

                // Check if this is a build artifact path and strip build dir + source node name
                const resolvedBuildDir = path.resolve(this.buildDir);
                const resolvedInputPath = path.resolve(inputPath);

                if (resolvedInputPath.startsWith(resolvedBuildDir)) {
                    // Strip build dir: .efes-build/upstream:transform/some/path/file.html
                    const afterBuildDir = path.relative(resolvedBuildDir, resolvedInputPath);

                    // Strip source node name: upstream:transform/some/path/file.html -> some/path/file.html
                    const pathParts = afterBuildDir.split(path.sep);
                    if (pathParts.length > 1) {
                        relativePath = path.join(...pathParts.slice(1));
                    }
                } else {
                    // For non-build paths, make them relative to cwd
                    relativePath = path.relative(process.cwd(), inputPath);
                }

                // Now build the new path
                const buildPath = path.join(this.buildDir, nodeName, relativePath);
                return newExtension ?
                    buildPath.replace(path.extname(buildPath), newExtension) :
                    buildPath;
            },
            stripBuildPrefix: (inputPath: string): string => {
                const resolvedBuildDir = path.resolve(this.buildDir);
                const resolvedInputPath = path.resolve(inputPath);

                if (resolvedInputPath.startsWith(resolvedBuildDir)) {
                    // Strip build dir: .efes-build/node-name/some/path/file.html
                    const afterBuildDir = path.relative(resolvedBuildDir, resolvedInputPath);

                    // Strip the first path segment (node directory): node-name/some/path/file.html -> some/path/file.html
                    const pathParts = afterBuildDir.split(path.sep);
                    if (pathParts.length > 1) {
                        return path.join(...pathParts.slice(1));
                    }
                    // If only one segment, return as is
                    return afterBuildDir;
                }

                // For non-build paths, make them relative to cwd
                return path.relative(process.cwd(), inputPath);
            },
            getNodeOutputs: (nodeName: string) => this.nodeOutputs.get(nodeName)
        }

        try {
            // Execute nodes based on chosen execution mode
            if (this.executionMode === 'sequential') {
                await this.executeSequential(executionOrder, context, runningNodes);
            } else if (this.executionMode === 'parallel') {
                const waves = this.calculateWaves(executionOrder);
                await this.executeParallel(waves, context, runningNodes);
            } else {
                // dynamic mode
                await this.executeDynamic(executionOrder, context, runningNodes);
            }

            const pipelineTime = ((performance.now() - pipelineStart) / 1000).toFixed(2);
            context.log(`Pipeline completed in ${pipelineTime}s`);

            // Print timing summary
            context.log(`\nNode timing summary:`);
            const timings = Array.from(this.nodeTimings.entries())
                .sort((a, b) => b[1] - a[1]); // Sort by time, slowest first

            for (const [nodeName, time] of timings) {
                context.log(`  ${nodeName.padEnd(40)} ${time.toFixed(2)}s`);
            }
        } finally {
            // Always cleanup: stop supervisor and terminate worker pool
            clearInterval(supervisorInterval);
            await this.workerPool.terminate();
        }
    }

    /**
     * Calculate dependency waves for parallel execution.
     * Nodes in the same wave have no dependencies on each other.
     */
    private calculateWaves(executionOrder: string[]): Map<number, string[]> {
        const depths = new Map<string, number>();
        const getDepth = (nodeName: string): number => {
            if (depths.has(nodeName)) return depths.get(nodeName)!;

            const deps = this.graph.dependenciesOf(nodeName);
            const depth = deps.length === 0 ? 0 : Math.max(...deps.map(getDepth)) + 1;
            depths.set(nodeName, depth);
            return depth;
        };

        // Group nodes into waves by depth
        const waveMap = new Map<number, string[]>();
        for (const nodeName of executionOrder) {
            const depth = getDepth(nodeName);
            if (!waveMap.has(depth)) waveMap.set(depth, []);
            waveMap.get(depth)!.push(nodeName);
        }

        return waveMap;
    }

    /**
     * Execute nodes sequentially in topological order.
     */
    private async executeSequential(
        executionOrder: string[],
        context: PipelineContext,
        runningNodes: Set<string>
    ): Promise<void> {
        for (const nodeName of executionOrder) {
            const node = this.graph.getNodeData(nodeName);
            const nodeStart = performance.now();
            context.log(`  ▶ Running: ${node.name}`);

            runningNodes.add(node.name);

            try {
                const output = await node.run(context);
                this.nodeOutputs.set(node.name, output);
                const nodeTime = (performance.now() - nodeStart) / 1000;
                this.nodeTimings.set(node.name, nodeTime);
                context.log(`    ✓ Completed: ${node.name} (${nodeTime.toFixed(2)}s)`);
            } catch (err: any) {
                context.log(`    ✗ Failed: ${node.name}`);
                context.log(`      ${err.message}`);
                throw err;
            } finally {
                runningNodes.delete(node.name);
            }
        }
    }

    /**
     * Execute nodes in parallel waves.
     * Nodes within each wave run in parallel, waves run sequentially.
     */
    private async executeParallel(
        waves: Map<number, string[]>,
        context: PipelineContext,
        runningNodes: Set<string>
    ): Promise<void> {
        const sortedWaves = Array.from(waves.entries()).sort((a, b) => a[0] - b[0]);

        for (const [waveNum, nodeNames] of sortedWaves) {
            context.log(`\n▶▶▶ Wave ${waveNum}: ${nodeNames.length} node(s) - ${nodeNames.join(', ')}`);

            // Run all nodes in this wave in parallel
            await Promise.all(nodeNames.map(async (nodeName) => {
                const node = this.graph.getNodeData(nodeName);
                const nodeStart = performance.now();
                context.log(`  ▶ Running: ${node.name}`);

                runningNodes.add(node.name);

                try {
                    const output = await node.run(context);
                    this.nodeOutputs.set(node.name, output);
                    const nodeTime = (performance.now() - nodeStart) / 1000;
                    this.nodeTimings.set(node.name, nodeTime);
                    context.log(`    ✓ Completed: ${node.name} (${nodeTime.toFixed(2)}s)`);
                } catch (err: any) {
                    context.log(`    ✗ Failed: ${node.name}`);
                    context.log(`      ${err.message}`);
                    throw err;
                } finally {
                    runningNodes.delete(node.name);
                }
            }));

            context.log(`  ✓ Wave ${waveNum} complete`);
        }
    }

    /**
     * Execute nodes dynamically based on dependency readiness.
     * Nodes start as soon as all their dependencies complete, maximizing parallelism.
     */
    private async executeDynamic(
        executionOrder: string[],
        context: PipelineContext,
        runningNodes: Set<string>
    ): Promise<void> {
        const completed = new Set<string>();
        const inProgress = new Set<string>();
        const pending = new Set(executionOrder);
        const errors: Error[] = [];

        // Helper: Check if node's dependencies are all complete
        const isReady = (nodeName: string): boolean => {
            const deps = this.graph.dependenciesOf(nodeName);
            return deps.every(dep => completed.has(dep));
        };

        // Helper: Run a single node
        const runNode = async (nodeName: string): Promise<void> => {
            const node = this.graph.getNodeData(nodeName);
            const nodeStart = performance.now();
            context.log(`  ▶ Running: ${node.name}`);

            runningNodes.add(node.name);

            try {
                const output = await node.run(context);
                this.nodeOutputs.set(node.name, output);
                const nodeTime = (performance.now() - nodeStart) / 1000;
                this.nodeTimings.set(node.name, nodeTime);
                context.log(`    ✓ Completed: ${node.name} (${nodeTime.toFixed(2)}s)`);
            } catch (err: any) {
                context.log(`    ✗ Failed: ${node.name}`);
                context.log(`      ${err.message}`);
                errors.push(err);
                throw err;
            } finally {
                runningNodes.delete(node.name);
                inProgress.delete(nodeName);
                completed.add(nodeName);
            }
        };

        // Start all ready nodes (non-blocking)
        const startReadyNodes = (): void => {
            for (const nodeName of pending) {
                if (!inProgress.has(nodeName) && isReady(nodeName)) {
                    pending.delete(nodeName);
                    inProgress.add(nodeName);

                    // Run node and check for newly ready nodes when complete
                    runNode(nodeName)
                        .then(() => {
                            if (errors.length === 0) {
                                startReadyNodes();
                            }
                        })
                        .catch(() => {
                            // Error already logged in runNode, don't start new nodes
                        });
                }
            }
        };

        // Initial kick-off
        startReadyNodes();

        // Wait for all nodes to complete or error
        while (inProgress.size > 0 || (pending.size > 0 && errors.length === 0)) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // If there were errors, throw the first one
        if (errors.length > 0) {
            throw errors[0];
        }
    }

    /**
     * Implementation of resolveInput without caching (used internally by cached version)
     */
    private async resolveInputImpl(input: Input): Promise<string[]> {
        // Node references
        if (inputIsNodeOutputReference(input)) {
            let outputs = this.nodeOutputs.get(input.node.name)?.flatMap(output => output[input.name]).filter(x => x !== undefined);
            if (!outputs || outputs.length === 0) {
                throw new Error(`Node "${input.node.name}" hasn't run yet or has not produced any outputs.`);
            }

            // Apply glob filtering if specified
            if (input.glob) {
                // Determine glob pattern based on first output location
                // (all outputs from a node are in the same location)
                let globPattern: string;
                if (outputs[0]?.startsWith(this.buildDir)) {
                    // Output is in default build directory - use full path for globbing
                    globPattern = `${this.buildDir}/*/${input.glob}`
                } else {
                    // Output is in custom location - glob from current root
                    globPattern = input.glob;
                }

                // Run glob ONCE to get all matches
                const matches = await glob(globPattern);
                const matchSet = new Set(matches);

                // Filter outputs to only those that match
                const filteredOutputs = outputs.filter(outputPath => matchSet.has(outputPath));

                if (filteredOutputs.length === 0) {
                    throw new Error(`No files from node "${input.node.name}" output "${input.name}" match pattern: ${input.glob}.\nOutputs: ${JSON.stringify(outputs, null, 2)}`);
                }
                outputs = filteredOutputs;
            }

            return outputs
        }

        // File paths
        if (typeof input === "string") {
            const results = await glob(input)
            if (results.length === 0) {
                throw new Error(`No files found for pattern: ${input}`);
            }
            return results
        }

        // Arrays of node references or file paths
        if (Array.isArray(input)) {
            const results: string[] = [];
            for (const item of input) {
                // Recursively call resolveInputImpl (not the cached version)
                results.push(...(await this.resolveInputImpl(item)))
            }
            return results;
        }

        return []
    }

    /**
     * Get the outputs of a specific node after pipeline execution.
     * Returns undefined if the node hasn't run yet or doesn't exist.
     */
    getNodeOutputs(nodeName: string): NodeOutput<any>[] | undefined {
        return this.nodeOutputs.get(nodeName);
    }
}