import {DepGraph} from "dependency-graph";
import {CacheManager} from "./cache";
import {glob} from "glob";
import path from "node:path";
import crypto from "node:crypto";

interface NodeOutputReference {
    node: PipelineNode<any, any>;
    name: string;
}

function inputIsNodeOutputReference(input: Input): input is NodeOutputReference {
    return typeof input === 'object' && 'node' in input && 'name' in input;
}

export type Input = string | string[] | NodeOutputReference;
export type NodeOutput<TKey extends string> = Record<TKey, string[]>;

export function from<TNode extends PipelineNode<any, TOutput>, TOutput extends string>(node: TNode, output: TOutput): NodeOutputReference {
    return {node, name: output as string};
}

export interface PipelineNodeConfig {
    name: string;
    inputs: Record<string, Input>;
    explicitDependencies?: string[];
}


export abstract class PipelineNode<TConfig extends PipelineNodeConfig = PipelineNodeConfig, TOutput extends string = string> {
    constructor(public readonly config: TConfig) {
    }

    get name() {
        return this.config.name;
    }

    get inputs(): TConfig["inputs"] {
        return this.config.inputs;
    }

    /**
     * Optional lifecycle hook called when this node is added to a pipeline.
     * Composite nodes can use this to expand their internal nodes.
     */
    onAddedToPipeline?(pipeline: Pipeline): void;

    abstract run(context: PipelineContext): Promise<NodeOutput<TOutput>[]>;

    /**
     * Generate a content signature for this node based on its configuration and inputs.
     * Nodes with identical signatures can share cache entries.
     */
    protected async getContentSignature(context: PipelineContext): Promise<string> {
        const inputHashes: string[] = [];

        // Include hashes of all inputs (both direct files and resolved from() references)
        for (const [inputName, input] of Object.entries(this.inputs)) {
            const resolvedPaths = await context.resolveInput(input);
            for (const filePath of resolvedPaths) {
                inputHashes.push(await context.cache.computeFileHash(filePath));
            }
        }

        // Include serialized configuration
        const configForHashing = {
            ...this.config,
            inputs: undefined, // Remove inputs from config hash since we handle them separately above
            name: undefined    // Remove name from config hash since it's just an identifier, not content
        };
        const configString = JSON.stringify(configForHashing, Object.keys(configForHashing).sort());

        // Combine all data and hash
        const combined = [...inputHashes.sort(), configString].join('|');
        const hash = crypto.createHash('sha256').update(combined).digest('hex');

        // Return human-readable signature: ClassName-hash8chars
        return `${this.constructor.name}-${hash.substring(0, 8)}`;
    }

    // Unified caching for single or multiple items
    protected async withCache<T>(
        context: PipelineContext,
        items: string[],
        getCacheKey: (item: string) => string,
        getOutputPath: (item: string) => string,
        performWork: (item: string) => Promise<T | { result?: T, discoveredDependencies?: string[] } | void>
    ): Promise<Array<{ item: string, output: string, cached: boolean, result?: T }>> {
        // Get content signature for cache sharing
        const contentSignature = await this.getContentSignature(context);

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
                const expectedOutputPath = getOutputPath(item);
                if (cached.outputPaths[0] !== expectedOutputPath) {
                    await context.cache.copyToExpectedPath(cached.outputPaths[0], expectedOutputPath);
                }
                results.push({item, output: expectedOutputPath, cached: true});
                continue;
            }

            const processed = await performWork(item);

            // Handle different return types
            let result: T | undefined;
            let discoveredDependencies: string[] | undefined;

            if (processed && typeof processed === 'object' && 'discoveredDependencies' in processed) {
                // Object with discovered dependencies
                result = processed.result;
                discoveredDependencies = processed.discoveredDependencies;
            } else {
                // Simple result value or void
                result = processed as T;
            }

            const cacheEntry = await context.cache.buildCacheEntry(
                [item], [outputPath], cacheKey, discoveredDependencies
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

    addNode(node: PipelineNode<any, any>): this {
        this.graph.addNode(node.name, node);

        // Call lifecycle hook if it exists
        if (node.onAddedToPipeline) {
            node.onAddedToPipeline(this);
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

    private setupInputDependencies() {
        // Setup input-based dependencies from from() references
        for (const nodeName of this.graph.overallOrder()) {
            const node = this.graph.getNodeData(nodeName);

            // Handle input-based dependencies (from from() references)
            for (const [_, input] of Object.entries(node.inputs)) {
                if (typeof input === 'object' && 'node' in input) {
                    try {
                        console.log(`Adding input dependency for node ${node.name}: ${input.node.name}`);
                        this.graph.addDependency(node.name, input.node.name);
                    } catch (err: any) {
                        throw new Error(`Failed to add input dependency for node ${node.name}: ${err.message}`);
                    }
                }
            }
        }
    }


    async run() {
        console.log(`Running pipeline ${this.name}`);
        console.log(`Number of nodes: ${this.graph.size()}`);

        // 1. Setup explicit dependencies first
        this.setupExplicitDependencies();

        // 2. Setup input-based dependencies (from from() references)
        this.setupInputDependencies();

        const executionOrder = this.graph.overallOrder();
        console.log(executionOrder)
        const context: PipelineContext = {
            resolveInput: async (input: Input): Promise<string[]> => {

                // Node references
                if (inputIsNodeOutputReference(input)) {
                    const outputs = this.nodeOutputs.get(input.node.name)?.flatMap(output => output[input.name]).filter(x => x !== undefined);
                    if (!outputs || outputs.length === 0) {
                        throw new Error(`Node "${input.node.name}" hasn't run yet or has not produced any outputs.`);
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
                const relativePath = path.relative(process.cwd(), inputPath);
                const buildPath = path.join(this.buildDir, nodeName, relativePath);
                return newExtension ?
                    buildPath.replace(path.extname(buildPath), newExtension) :
                    buildPath;
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