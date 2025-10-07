import {DepGraph} from "dependency-graph";
import {CacheManager} from "./cache";
import {glob} from "glob";
import path from "node:path";
import crypto from "node:crypto";

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

export interface PipelineNodeConfig {
    name: string;
    // 0-1 variable input (what to process)
    items?: Input;
    // Processing configuration (may contain FileRef values)
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


    get items(): Input | undefined {
        return this.config.items;
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
    protected async getContentSignature(context: PipelineContext): Promise<string> {
        const fileRefs: string[] = [];
        const processingConfig = { ...this.config.config };

        // Extract fileRef paths from config (stable file identities, not content hashes)
        for (const [key, value] of Object.entries(this.config.config || {})) {
            if (value?.type === 'file') {
                fileRefs.push(`${key}:${path.resolve(value.path)}`);
                delete processingConfig[key]; // Remove from config hash
            }
        }

        // Include items in the signature for input-dependent processing
        let itemsSignature = '';
        if (this.items) {
            if (typeof this.items === 'string') {
                itemsSignature = `items:${this.items}`;
            } else if (Array.isArray(this.items)) {
                itemsSignature = `items:[${this.items.join(',')}]`;
            } else {
                // For NodeOutputReference, use node name and output name
                itemsSignature = `items:${this.items.node.name}:${this.items.name}`;
            }
        }

        // Combine file identities + processing config + items (outputConfig excluded by design)
        const configString = JSON.stringify(processingConfig, Object.keys(processingConfig).sort());
        const combined = [...fileRefs.sort(), configString, itemsSignature].filter(x => x).join('|');
        const hash = crypto.createHash('sha256').update(combined).digest('hex');

        return `${this.constructor.name}-${hash.substring(0, 8)}`;
    }

    // Unified caching for single or multiple items
    protected async withCache<T>(
        context: PipelineContext,
        items: string[],
        getCacheKey: (item: string) => string,
        getOutputPath: (item: string) => string,
        performWork: (item: string, outputPath: string) => Promise<T | { result?: T, discoveredDependencies?: string[] } | void>
    ): Promise<Array<{ item: string, output: string, cached: boolean, result?: T }>> {
        const contentSignature = await this.getContentSignature(context);

        // Extract fileRef paths and resolve from() references for cache entries
        const configDependencyPaths: string[] = [];
        const processConfigValue = async (value: any) => {
            if (value?.type === 'file') {
                // FileRef - extract path directly
                configDependencyPaths.push(value.path);
            } else if (inputIsNodeOutputReference(value)) {
                // from() reference - resolve to file paths
                const resolvedPaths = await context.resolveInput(value);
                configDependencyPaths.push(...resolvedPaths);
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

        const cacheKeys = items.map(getCacheKey);
        await context.cache.cleanExcept(contentSignature, cacheKeys);

        const results = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const cacheKey = cacheKeys[i];
            const outputPath = getOutputPath(item);

            const cached = await context.cache.getCache(contentSignature, cacheKey);
            if (cached && await context.cache.isValid(cached)) {
                context.log(`  - Skipping: ${item} (cached)`);
                // Copy cached output to expected build path if different
                if (cached.outputPaths[0] !== outputPath) {
                    await context.cache.copyToExpectedPath(cached.outputPaths[0], outputPath);
                }
                results.push({item, output: outputPath, cached: true});
                continue;
            }

            const processed = await performWork(item, outputPath);

            // Handle different return types
            let result: T | undefined;
            let discoveredDependencies: string[] | undefined;

            if (processed && typeof processed === 'object' && 'discoveredDependencies' in processed) {
                result = processed.result;
                discoveredDependencies = processed.discoveredDependencies;
            } else {
                result = processed as T;
            }

            // Build unified cache entry
            const cacheEntry = await context.cache.buildCacheEntry(
                [item],                    // Item files
                [outputPath],              // Output files
                cacheKey,                  // Cache key
                discoveredDependencies,    // Discovered dependencies
                configDependencyPaths      // Config dependencies (FileRefs + resolved from() references)
            );
            await context.cache.setCache(contentSignature, cacheKey, cacheEntry);

            results.push({item, output: outputPath, cached: false, result});
        }
        return results;
    }
}

export interface PipelineContext {
    resolveInput(input: Input): Promise<string[]>;

    log(message: string): void;

    cache: CacheManager;
    buildDir: string;

    getBuildPath(nodeName: string, inputPath: string, newExtension?: string): string;
    stripBuildPrefix(inputPath: string): string;
    getNodeOutputs(nodeName: string): NodeOutput<any>[] | undefined;
}

export class Pipeline {
    private graph = new DepGraph<PipelineNode>();
    private nodeOutputs = new Map<string, NodeOutput<any>[]>;
    private cache: CacheManager;

    constructor(
        public readonly name: string,
        public readonly buildDir: string = '.efes-build',
        public readonly cacheDir: string = '.efes-cache'
    ) {
        this.cache = new CacheManager(cacheDir);
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
                    console.log(`Adding automatic dependency for node ${node.name}: ${node.items.node.name} (from items)`);
                    this.graph.addDependency(node.name, node.items.node.name);
                } catch (err: any) {
                    throw new Error(`Failed to add automatic dependency for node ${node.name}: ${err.message}`);
                }
            }

            // Check config values for NodeOutputReferences
            if (node.config) {
                for (const [key, value] of Object.entries(node.config)) {
                    if (inputIsNodeOutputReference(value)) {
                        try {
                            console.log(`Adding automatic dependency for node ${node.name}: ${value.node.name} (from config.${key})`);
                            this.graph.addDependency(node.name, value.node.name);
                        } catch (err: any) {
                            throw new Error(`Failed to add automatic dependency for node ${node.name}: ${err.message}`);
                        }
                    }
                }
            }
        }
    }

    async run() {
        console.log(`Running pipeline ${this.name}`);
        console.log(`Number of nodes: ${this.graph.size()}`);

        // Setup explicit dependencies
        this.setupExplicitDependencies();

        // Setup automatic dependencies from NodeOutputReferences
        this.setupAutomaticDependencies();

        const executionOrder = this.graph.overallOrder();
        console.log(executionOrder)
        const context: PipelineContext = {
            resolveInput: async (input: Input): Promise<string[]> => {

                // Node references
                if (inputIsNodeOutputReference(input)) {
                    let outputs = this.nodeOutputs.get(input.node.name)?.flatMap(output => output[input.name]).filter(x => x !== undefined);
                    if (!outputs || outputs.length === 0) {
                        throw new Error(`Node "${input.node.name}" hasn't run yet or has not produced any outputs.`);
                    }


                    // Apply glob filtering if specified
                    if (input.glob) {
                        const filteredOutputs: string[] = [];

                        let globPattern: string;

                        for (const outputPath of outputs) {

                            if (outputPath.startsWith(this.buildDir)) {
                                // Output is in default build directory - use full path for globbing
                                globPattern = `${this.buildDir}/*/${input.glob}`
                            } else {
                                // Output is in custom location - glob from current root
                                globPattern = input.glob;
                            }

                            // Use Node.js glob to find matching files
                            const matches = await glob(globPattern);
                            if (matches.includes(outputPath)) {
                                filteredOutputs.push(outputPath);
                            }
                        }

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
                        results.push(...(await context.resolveInput(item)))
                    }
                    return results;
                }

                return []
            },
            log: (message: string) => console.log(`  [${this.name}] ${message}`),
            cache: this.cache,
            buildDir: this.buildDir,
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

        for (const nodeName of executionOrder) {
            const node = this.graph.getNodeData(nodeName);
            context.log(`▶ Running node: ${node.name}`);

            try {
                const output = await node.run(context);
                // context.log(`  → Generated: ${JSON.stringify(output)}`);

                this.nodeOutputs.set(node.name, output);
                context.log(`  - Completed: ${node.name}`);
            } catch (err: any) {
                context.log(`  - Failed: ${node.name}`);
                context.log(`    ${err.message}`);
                throw err;
            }
        }

        context.log(`Pipeline completed.`);
    }

    /**
     * Get the outputs of a specific node after pipeline execution.
     * Returns undefined if the node hasn't run yet or doesn't exist.
     */
    getNodeOutputs(nodeName: string): NodeOutput<any>[] | undefined {
        return this.nodeOutputs.get(nodeName);
    }
}