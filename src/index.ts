import * as fs from "node:fs/promises";
import * as path from "node:path";
import {fork} from "child_process";
import { DepGraph }  from "dependency-graph"
import { glob } from "glob";
import { CacheManager } from "./cache";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { transform, getResource, XPath } = require('saxon-js');



interface NodeOutputReference {
    node: PipelineNode<any, any>;
    name: string;
}

function inputIsNodeOutputReference(input: Input): input is NodeOutputReference {
    return typeof input === 'object' && 'node' in input && 'name' in input;
}


type Input = string | string[] | NodeOutputReference;

type NodeOutput<TKey extends string> = Record<TKey, string[]>;

export function from<TNode extends PipelineNode<any, TOutput>, TOutput extends string>(node: TNode, output: TOutput): NodeOutputReference {
    return { node, name: output as string};
}


interface PipelineNodeConfig {
    name: string;
    inputs: Record<string, Input>;
}

abstract class PipelineNode<TConfig extends PipelineNodeConfig = PipelineNodeConfig, TOutput extends string = string> {
    constructor(public readonly config: TConfig) {}

    get name() { return this.config.name; }
    get inputs(): TConfig["inputs"] { return this.config.inputs; }

    abstract run(context: PipelineContext): Promise<NodeOutput<TOutput>[]>;

    // Unified caching for single or multiple items
    protected async withCache<T>(
        context: PipelineContext,
        items: string[],
        getCacheKey: (item: string) => string,
        getOutputPath: (item: string) => string,
        performWork: (item: string) => Promise<T | { result?: T, implicitDependencies?: string[] } | void>
    ): Promise<Array<{item: string, output: string, cached: boolean, result?: T}>> {
        // Auto-detect dependencies from from() inputs
        const deps: Record<string, {path: string, hash: string}> = {};
        for (const [inputName, input] of Object.entries(this.inputs)) {
            if (inputIsNodeOutputReference(input)) {
                const resolvedPaths = await context.resolveInput(input);
                if (resolvedPaths.length > 0) {
                    deps[inputName] = {
                        path: resolvedPaths[0],
                        hash: await context.cache.computeFileHash(resolvedPaths[0])
                    };
                }
            }
        }

        const cacheKeys = items.map(getCacheKey);
        await context.cache.cleanExcept(this.name, cacheKeys);

        const results = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const cacheKey = cacheKeys[i];
            const outputPath = getOutputPath(item);

            const cached = await context.cache.getCache(this.name, cacheKey);
            if (cached && await context.cache.isValid(cached)) {
                context.log(`  - Skipping: ${item} (cached)`);
                results.push({item, output: cached.outputPaths[0], cached: true});
                continue;
            }

            const processed = await performWork(item);

            // Handle different return types
            let result: T | undefined;
            let implicitDependencies: string[] | undefined;

            if (processed && typeof processed === 'object' && 'implicitDependencies' in processed) {
                // Object with implicit dependencies
                result = processed.result;
                implicitDependencies = processed.implicitDependencies;
            } else {
                // Simple result value or void
                result = processed as T;
            }

            const cacheEntry = await context.cache.buildCacheEntry(
                [item], [outputPath], deps, cacheKey, implicitDependencies
            );
            await context.cache.setCache(this.name, cacheKey, cacheEntry);

            results.push({item, output: outputPath, cached: false, result});
        }
        return results;
    }
}

interface PipelineContext {
    resolveInput(input: Input): Promise<string[]>;
    log(message: string): void;
    cache: CacheManager;
}

export class Pipeline {
    private graph = new DepGraph<PipelineNode>();
    private nodeOutputs = new Map<string, NodeOutput<any>[]>;
    private cache = new CacheManager();

    constructor(public readonly name: string) { }

    addNode(node: PipelineNode<any, any>): this {
        this.graph.addNode(node.name, node);
        return this;
    }

    private setupDependencies() {
        for (const nodeName of this.graph.entryNodes()) {
            const node = this.graph.getNodeData(nodeName);
            for (const [_, input] of Object.entries(node.inputs)) {
                if (typeof input === 'object' && 'node' in input) {
                    try {
                        console.log(`Adding dependency for node ${node.name}: ${input.node.name}`);
                        this.graph.addDependency(node.name, input.node.name);
                    } catch (err: any) {
                        throw new Error(`Failed to add dependency for node ${node.name}: ${err.message}`);
                    }
                }
            }
        }
    }

    async run() {
        console.log(`Running pipeline ${this.name}`);
        console.log(`Number of nodes: ${this.graph.size}`);
        this.setupDependencies();

        const executionOrder = this.graph.overallOrder();
        console.log(executionOrder)
        const context: PipelineContext = {
            resolveInput: async (input: Input): Promise<string[]> => {

                // Node references
                if (inputIsNodeOutputReference(input)) {
                    const outputs = this.nodeOutputs.get(input.node.name)?.flatMap(output => output[input.name]);
                    if (!outputs) {
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
        }

        for (const nodeName of executionOrder) {
            const node = this.graph.getNodeData(nodeName);
            context.log(`▶ Running node: ${node.name}`);

            // const outputs: NodeOutput<any>[] = [];
            try {
                // for await (const output of node.run(context)) {
                //     outputs.push(output);
                //     context.log(`  → Generated: ${JSON.stringify(output, null, 2)}`);
                // }
                const output = await node.run(context);
                context.log(`  → Generated: ${JSON.stringify(output, null, 2)}`);

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
}

interface CompileStylesheetConfig extends PipelineNodeConfig {
    name: string;
    inputs: { xslt: Input };
    outputFilename: string;
}


export class CompileStylesheetNode extends PipelineNode<CompileStylesheetConfig, "compiledStylesheet"> {
    async run(context: PipelineContext) {
        const xsltPath = await context.resolveInput(this.inputs.xslt);
        if (xsltPath.length !== 1) throw new Error("Multiple xslt input files not supported");

        const sefPath = path.resolve(this.config.outputFilename);

        const results = await this.withCache(
            context,
            xsltPath,
            (item) => item,
            () => sefPath,
            async (item) => {
                context.log(`Compiling ${item} to ${sefPath}`);

                // Extract XSLT dependencies before compilation
                const implicitDependencies = await this.extractXsltDependencies(item);
                context.log(`  Found ${implicitDependencies.length} dependencies: ${JSON.stringify(implicitDependencies)}`);

                try {
                    await new Promise<void>((resolve, reject) => {
                        const xslt3Path = require.resolve('xslt3');

                        const child = fork(xslt3Path, [
                            `-xsl:${xsltPath[0]}`,
                            `-export:${sefPath}`,
                            '-relocate:on',
                            '-nogo'
                        ], {
                            silent: true // Capture stdio
                        });

                        let stdout = '';
                        let stderr = '';

                        if (child.stdout) {
                            child.stdout.on('data', (data) => {
                                stdout += data.toString();
                            });
                        }

                        if (child.stderr) {
                            child.stderr.on('data', (data) => {
                                stderr += data.toString();
                            });
                        }

                        child.on('close', (code) => {
                            if (code === 0) {
                                console.log(`Successfully compiled: ${path.basename(sefPath)}`);
                                resolve();
                            } else {
                                reject(new Error(`XSLT compilation failed with exit code ${code}\nstderr: ${stderr}`));
                            }
                        });

                        child.on('error', (err) => {
                            reject(new Error(`Failed to fork xslt3 process: ${err.message}`));
                        });
                    });

                    return { implicitDependencies };
                } catch (err: any) {
                    throw new Error(`Failed to compile XSL: ${err.message}`);
                }
            }
        );

        return [{ compiledStylesheet: [results[0].output] }];
    }

    private async extractXsltDependencies(xsltPath: string): Promise<string[]> {
        const allDependencies = new Set<string>();
        const processed = new Set<string>();

        async function processFile(filePath: string) {
            if (processed.has(filePath)) return;
            processed.add(filePath);

            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const doc = await getResource({text: content, type: 'xml'});

                // Use XPath to find xsl:import and xsl:include elements
                const imports = XPath.evaluate("//(xsl:import|xsl:include)/@href/data(.)", doc, {
                    namespaceContext: {xsl: 'http://www.w3.org/1999/XSL/Transform'},
                    resultForm: 'array'
                });

                for (const href of imports) {
                    const resolvedPath = path.resolve(path.dirname(filePath), href);
                    allDependencies.add(resolvedPath);
                    await processFile(resolvedPath); // Recursively process dependencies
                }
            } catch (error) {
                console.warn(`Could not parse XSLT dependencies from ${filePath}:`, error);
            }
        }

        await processFile(xsltPath);
        return Array.from(allDependencies);
    }
}

// const n = new CompileStylesheetNode({
//     name: "asdf",
//     outputFilename: "sdf",
//     inputs: {xslt: "adsf.xsl"}
// })
//
// from(n, "compiledStylesheet")

interface XsltTransformConfig extends PipelineNodeConfig {
    name: string;
    inputs: {
        sefStylesheet: Input;
        sourceXml?: Input;
    };
    outputFilenameMapping?: (inputPath: string) => string;
    resultDocumentsDir?: string;
}

export class XsltTransformNode extends PipelineNode<XsltTransformConfig, "transformed" | "result-documents"> {
    private defaultOutputFilenameMapping = (inputPath: string) => {
        const inputFilename = path.basename(inputPath);
        const inputDirname = path.dirname(inputPath);
        const inputBasename = path.basename(inputFilename, path.extname(inputFilename));
        return path.join(inputDirname, inputBasename + '.html');
    }


    async run(context: PipelineContext) {
        const sefStylesheetPath = (await context.resolveInput(this.inputs.sefStylesheet))[0];

        // Handle no-source mode (stylesheet uses document() for input)
        const sourcePaths = this.inputs.sourceXml ?
            await context.resolveInput(this.inputs.sourceXml) :
            [sefStylesheetPath];

        const isNoSourceMode = !this.inputs.sourceXml;
        context.log(`${isNoSourceMode ? 'Running stylesheet' : `Transforming ${sourcePaths.length} file(s)`} with ${sefStylesheetPath}`);

        const outputFilenameMapper = this.config.outputFilenameMapping ?? this.defaultOutputFilenameMapping;

        const results = await this.withCache(
            context,
            sourcePaths,
            (item) => isNoSourceMode ? `no-source-${sefStylesheetPath}` : `${item}-with-${sefStylesheetPath}`,
            (item) => isNoSourceMode ?
                (this.config.outputFilenameMapping?.(sefStylesheetPath) ?? sefStylesheetPath.replace('.sef.json', '.html')) :
                outputFilenameMapper(item),
            async (sourcePath) => {

                const transformOptions: any = {
                    stylesheetFileName: sefStylesheetPath,
                    destination: 'serialized'
                };

                if (!isNoSourceMode) {
                    transformOptions.sourceFileName = sourcePath;
                }

                const result = await transform(transformOptions);
                const outputPath = isNoSourceMode ?
                (this.config.outputFilenameMapping?.(sefStylesheetPath) ?? sefStylesheetPath.replace('.sef.json', '.html')) :
                outputFilenameMapper(sourcePath);

                await fs.writeFile(outputPath, result.principalResult);
                context.log(`  - Generated: ${outputPath}`);
            }
        );

        return results.map(r => ({
            transformed: [r.output],
            "result-documents": []
        }));
    }
}